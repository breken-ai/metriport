import {
  Patient,
  PatientCreate,
  PatientData,
  PatientDemoData,
} from "@metriport/core/domain/patient";
import { PatientSettingsData } from "@metriport/core/domain/patient-settings";
import { analytics, EventTypes } from "@metriport/core/external/analytics/posthog";
import { toFHIR } from "@metriport/core/external/fhir/patient/conversion";
import { out } from "@metriport/core/util";
import { processAsyncError } from "@metriport/core/util/error/shared";
import { uuidv7 } from "@metriport/core/util/uuid-v7";
import { upsertPatientToFHIRServer } from "../../../external/fhir/patient/upsert-patient";
import { runInitialPatientDiscoveryAcrossHies } from "../../../external/hie/run-initial-patient-discovery";
import { PatientModel } from "../../../models/medical/patient";
import { getFacilityOrFail } from "../facility/get-facility";
import { addPatientToCohorts } from "../cohort/patient-cohort/add-patient-to-cohorts";
import { addCoordinatesToAddresses } from "./add-coordinates";
import { attachPatientIdentifiers, getPatientByDemo, PatientWithIdentifiers } from "./get-patient";
import { createPatientSettings } from "./settings/create-patient-settings";
import { sanitize, validate } from "./shared";

type Identifier = Pick<Patient, "cxId" | "externalId"> & { facilityId: string };
type PatientNoExternalData = Omit<PatientData, "externalData">;
export type PatientCreateCmd = PatientNoExternalData & Identifier;

export type CreatePatientResult = {
  patient: PatientWithIdentifiers;
  /** false when the demographics matched an existing patient and nothing was created */
  wasCreated: boolean;
};

/**
 * Creates the patient if no patient with matching demographics exists for the customer,
 * otherwise returns the existing patient. `wasCreated` tells callers which one happened.
 */
export async function createPatientIfNotExists({
  patient,
  runPd = true,
  rerunPdOnNewDemographics,
  forceCommonwell,
  forceCarequality,
  settings,
  cohortIds,
}: {
  patient: PatientCreateCmd;
  runPd?: boolean;
  rerunPdOnNewDemographics?: boolean;
  forceCommonwell?: boolean;
  forceCarequality?: boolean;
  settings?: PatientSettingsData;
  cohortIds?: string[];
}): Promise<PatientWithIdentifiers> {
  const { cxId, facilityId, externalId } = patient;
  const { log } = out(`createPatient.${cxId}`);

  const sanitized = sanitize(patient);
  validate(sanitized);
  const { firstName, lastName, dob, genderAtBirth, personalIdentifiers, address, contact } =
    sanitized;
  const demo: PatientDemoData = {
    firstName,
    lastName,
    dob,
    genderAtBirth,
    personalIdentifiers,
    address,
    contact,
  };

  const patientExists = await getPatientByDemo({ cxId, demo });
  if (patientExists) return { patient: patientExists, wasCreated: false };

  // validate facility exists and cx has access to it
  await getFacilityOrFail({ cxId, id: facilityId });

  const patientCreate: PatientCreate = {
    id: uuidv7(),
    cxId,
    facilityIds: [facilityId],
    externalId,
    data: {
      firstName,
      lastName,
      dob,
      genderAtBirth,
      personalIdentifiers,
      address,
      contact,
    },
  };
  const addressWithCoordinates = await addCoordinatesToAddresses({
    addresses: patientCreate.data.address,
    cxId: patientCreate.cxId,
    reportRelevance: true,
    log,
  });
  if (addressWithCoordinates) patientCreate.data.address = addressWithCoordinates;

  const newPatient = await PatientModel.create(patientCreate);

  analytics({
    distinctId: cxId,
    event: EventTypes.patientCreate,
    properties: {
      patientId: newPatient.id,
      facilityId,
      rerunPdOnNewDemographics,
      runPd,
      forceCommonwell,
      forceCarequality,
    },
  });

  const fhirPatient = toFHIR(newPatient);

  await Promise.all([
    createPatientSettings({
      cxId,
      patientId: patientCreate.id,
      ...settings,
    }),
    upsertPatientToFHIRServer(newPatient.cxId, fhirPatient),
    cohortIds && cohortIds.length > 0
      ? addPatientToCohorts({
          cxId,
          patientId: patientCreate.id,
          cohortIds,
        })
      : Promise.resolve(),
  ]);

  if (runPd) {
    runInitialPatientDiscoveryAcrossHies({
      patient: newPatient.dataValues,
      facilityId,
      rerunPdOnNewDemographics,
      forceCarequality,
      forceCommonwell,
    }).catch(processAsyncError("runInitialPatientDiscoveryAcrossHies"));
  }
  const patientWithIdentifiers = await attachPatientIdentifiers(newPatient.dataValues);
  return { patient: patientWithIdentifiers, wasCreated: true };
}

/**
 * Creates the patient if it doesn't exist yet, returning the (possibly pre-existing) patient.
 * Use createPatientIfNotExists when the caller needs to know whether a patient was created.
 */
export async function createPatient(params: {
  patient: PatientCreateCmd;
  runPd?: boolean;
  rerunPdOnNewDemographics?: boolean;
  forceCommonwell?: boolean;
  forceCarequality?: boolean;
  settings?: PatientSettingsData;
  cohortIds?: string[];
}): Promise<PatientWithIdentifiers> {
  const { patient } = await createPatientIfNotExists(params);
  return patient;
}
