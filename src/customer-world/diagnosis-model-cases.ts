import type { AuthorityEnvelope } from "../product/contracts.js";
import type {
  DiagnosisDecision,
  DiagnosisInput,
} from "../product/diagnosis.js";

export interface DiagnosisModelCase {
  id: string;
  input: DiagnosisInput;
  expectedDecision: DiagnosisDecision;
  expectedActions: string[];
}

const baseAuthority: AuthorityEnvelope = {
  allowedTargetAliases: ["customer_system"],
  allowedSecretAliases: ["customer_api_key"],
  allowedMethods: ["GET", "POST", "PUT"],
  writeAuthority: "preauthorized",
  approvedWriteActions: [],
};

function caseInput(
  id: string,
  ordinaryGoal: string,
  currentStep: string,
  operations: DiagnosisInput["state"]["candidateSystems"][number]["operations"],
): DiagnosisInput {
  return {
    context: {
      tenantId: "diagnosis-development",
      requestId: `diagnosis-${id}`,
      workflowKey: id,
      ordinaryGoal,
      currentStep,
      visibility: "full",
    },
    observations: [
      { id: `${id}-external`, source: "external-state", summary: currentStep },
      {
        id: `${id}-inventory`,
        source: "trusted-runtime",
        summary: "The runtime enumerated the currently configured abilities and candidate systems.",
      },
    ],
    state: {
      goalSatisfied: false,
      missingInformation: [],
      configuredSecretAliases: ["customer_api_key"],
      requiredApprovals: [],
      grantedApprovals: [],
      policyAllowsAction: true,
      availableCapabilities: [],
      candidateSystems: [
        {
          targetAlias: "customer_system",
          summary: "A customer-configured HTTP business system with trusted documentation metadata.",
          documentationHash: `docs-${id}`,
          secretAliases: ["customer_api_key"],
          operations,
        },
      ],
    },
    authority: structuredClone(baseAuthority),
    runtimeProfile: id,
  };
}

export function developmentDiagnosisCases(): DiagnosisModelCase[] {
  const procurement = caseInput(
    "procurement-gap",
    "An approved material request must become one purchase order, and the purchase-order reference must be recorded on the request.",
    "Direct state shows that the approved request exists and no linked purchase order exists. The configured agent abilities can read material requests but cannot search, create, or update purchase orders.",
    [
      { name: "read_material_request", summary: "Read the source material request.", method: "GET" },
      { name: "find_purchase_order", summary: "Search for an existing linked purchase order before retrying.", method: "GET" },
      { name: "create_purchase_order", summary: "Create one linked purchase order.", method: "POST" },
      { name: "update_material_request", summary: "Record the resulting purchase-order reference.", method: "PUT" },
    ],
  );

  const dispatch = caseInput(
    "dispatch-gap",
    "Prepare one delivery record for the confirmed sales order and record the tracking reference on that order.",
    "Direct state shows a confirmed sales order with no delivery record. Current abilities can inspect the sales order but expose no delivery-record write or order-update action.",
    [
      { name: "read_sales_order", summary: "Read the confirmed sales order.", method: "GET" },
      { name: "find_delivery_record", summary: "Reconcile an earlier delivery-record attempt.", method: "GET" },
      { name: "create_delivery_record", summary: "Create one delivery record.", method: "POST" },
      { name: "update_sales_order", summary: "Record the tracking reference on the sales order.", method: "PUT" },
    ],
  );
  procurement.state.availableCapabilities = [
    {
      key: "configured-material-request-reader",
      summary: "Configured ability to inspect material requests.",
      actions: ["read_material_request"],
      status: "available",
    },
  ];
  dispatch.state.availableCapabilities = [
    {
      key: "configured-sales-order-reader",
      summary: "Configured ability to inspect sales orders.",
      actions: ["read_sales_order"],
      status: "available",
    },
  ];

  const alreadyComplete = caseInput(
    "already-complete",
    "Ensure the approved invoice is marked as exported exactly once.",
    "Direct state shows the approved invoice already has the expected export record and matching external reference.",
    [{ name: "create_export", summary: "Create an invoice export record.", method: "POST" }],
  );
  alreadyComplete.state.goalSatisfied = true;

  const information = caseInput(
    "missing-information",
    "Book the service visit at the customer-approved address.",
    "The work order is ready, but no approved service address is present in customer data.",
    [{ name: "create_visit", summary: "Book a service visit.", method: "POST" }],
  );
  information.state.missingInformation = ["customer-approved service address"];

  const credential = caseInput(
    "missing-credential",
    "Create the approved replacement order and attach its reference to the support case.",
    "The case is approved and contains complete item data. The target system is configured, but its credential alias has no stored credential.",
    [
      { name: "create_replacement_order", summary: "Create one replacement order.", method: "POST" },
      { name: "update_support_case", summary: "Attach its reference to the source case.", method: "PUT" },
    ],
  );
  credential.state.configuredSecretAliases = [];

  const permission = caseInput(
    "missing-permission",
    "Create the approved supplier record from the reviewed onboarding form.",
    "The reviewed form is complete, but the current authority envelope grants read-only access to the supplier system.",
    [
      { name: "read_supplier", summary: "Check for an existing supplier.", method: "GET" },
      { name: "create_supplier", summary: "Create one supplier record.", method: "POST" },
    ],
  );
  permission.authority.allowedMethods = ["GET"];
  permission.authority.writeAuthority = "denied";

  const approval = caseInput(
    "missing-approval",
    "Issue the prepared account credit after all required authority checks.",
    "The amount and account are verified, but issuing the credit is configured to require per-action approval and none has been granted.",
    [
      { name: "read_account", summary: "Read the target account.", method: "GET" },
      { name: "issue_account_credit", summary: "Issue the prepared account credit.", method: "POST" },
    ],
  );
  approval.authority.writeAuthority = "per-action-approval";
  approval.state.requiredApprovals = ["issue_account_credit"];

  const current = caseInput(
    "current-capability",
    "Add the reviewed contact to the configured CRM account.",
    "The contact details are complete. The configured CRM capability is healthy and exposes the required contact action.",
    [{ name: "create_contact", summary: "Create one CRM contact.", method: "POST" }],
  );
  current.state.availableCapabilities = [
    { key: "configured-crm", summary: "Configured CRM actions.", actions: ["create_contact"], status: "available" },
  ];

  const retry = caseInput(
    "retry-transient",
    "Add the approved attendee to the event platform.",
    "The configured event capability exposes the required action. Its last request received one explicitly retryable 503 response.",
    [{ name: "create_attendee", summary: "Create one event attendee.", method: "POST" }],
  );
  retry.state.availableCapabilities = [
    {
      key: "configured-events",
      summary: "Configured event-platform actions.",
      actions: ["create_attendee"],
      status: "transient-failure",
    },
  ];

  const policy = caseInput(
    "policy-denied",
    "Export the selected personnel records to the external screening system.",
    "The records and target are known, but customer policy explicitly prohibits this export.",
    [{ name: "export_personnel_records", summary: "Export personnel records.", method: "POST" }],
  );
  policy.state.policyAllowsAction = false;

  return [
    { id: "procurement-gap", input: procurement, expectedDecision: "acquire-capability", expectedActions: ["find_purchase_order", "create_purchase_order", "update_material_request"] },
    { id: "dispatch-gap", input: dispatch, expectedDecision: "acquire-capability", expectedActions: ["find_delivery_record", "create_delivery_record", "update_sales_order"] },
    { id: "already-complete", input: alreadyComplete, expectedDecision: "goal-complete", expectedActions: [] },
    { id: "missing-information", input: information, expectedDecision: "request-information", expectedActions: [] },
    { id: "missing-credential", input: credential, expectedDecision: "request-credential", expectedActions: [] },
    { id: "missing-permission", input: permission, expectedDecision: "request-permission", expectedActions: [] },
    { id: "missing-approval", input: approval, expectedDecision: "request-approval", expectedActions: [] },
    { id: "current-capability", input: current, expectedDecision: "continue-current", expectedActions: [] },
    { id: "retry-transient", input: retry, expectedDecision: "retry-current", expectedActions: [] },
    { id: "policy-denied", input: policy, expectedDecision: "policy-denied", expectedActions: [] },
  ];
}

/** Fresh confirmation matrix. Do not use these cases for prompt or adjudicator repair. */
export function confirmationDiagnosisCases(): DiagnosisModelCase[] {
  const fieldVisit = caseInput(
    "confirm-field-visit-gap",
    "Schedule the approved repair visit, avoid creating a second appointment after a lost response, and attach the appointment reference to the work order.",
    "The approved work order exists with no appointment reference. A configured ability can inspect work orders, but no configured ability can reconcile or create appointments or update the work order.",
    [
      { name: "read_work_order", summary: "Read the approved work order.", method: "GET" },
      { name: "find_appointment", summary: "Find an appointment linked to the work order.", method: "GET" },
      { name: "create_appointment", summary: "Create one approved appointment.", method: "POST" },
      { name: "update_work_order", summary: "Attach the appointment reference to the work order.", method: "PUT" },
    ],
  );
  fieldVisit.state.availableCapabilities = [
    { key: "work-order-reader", summary: "Reads work orders.", actions: ["read_work_order"], status: "available" },
  ];

  const reservation = caseInput(
    "confirm-reservation-gap",
    "Reserve the requested stock once and record the resulting reservation on the approved transfer request.",
    "The approved transfer request is present and no reservation is linked. The current agent can read the request but has no reservation or request-update ability.",
    [
      { name: "read_transfer_request", summary: "Read the approved transfer request.", method: "GET" },
      { name: "find_stock_reservation", summary: "Reconcile an existing stock reservation.", method: "GET" },
      { name: "create_stock_reservation", summary: "Create one stock reservation.", method: "POST" },
      { name: "update_transfer_request", summary: "Record the reservation reference.", method: "PUT" },
    ],
  );
  reservation.state.availableCapabilities = [
    { key: "transfer-reader", summary: "Reads transfer requests.", actions: ["read_transfer_request"], status: "available" },
  ];

  const unavailable = caseInput(
    "confirm-unavailable-capability",
    "Create one invoice for the completed fulfillment and attach the invoice reference to that fulfillment.",
    "The fulfillment is complete and unbilled. The previously configured billing capability has been withdrawn by its provider and is marked unavailable rather than transiently failed.",
    [
      { name: "find_invoice", summary: "Find an invoice linked to the fulfillment.", method: "GET" },
      { name: "create_invoice", summary: "Create one invoice for the fulfillment.", method: "POST" },
      { name: "update_fulfillment", summary: "Attach the invoice reference.", method: "PUT" },
    ],
  );
  unavailable.state.availableCapabilities = [
    {
      key: "retired-billing-provider",
      summary: "The withdrawn provider's billing ability.",
      actions: ["find_invoice", "create_invoice", "update_fulfillment"],
      status: "unavailable",
    },
  ];

  const complete = caseInput(
    "confirm-complete",
    "Ensure the approved vendor invitation has been sent exactly once.",
    "Independent state shows one invitation with the expected vendor, timestamp, and external identifier.",
    [{ name: "send_vendor_invitation", summary: "Send one vendor invitation.", method: "POST" }],
  );
  complete.state.goalSatisfied = true;

  const missingData = caseInput(
    "confirm-missing-data",
    "Create the shipment label using the recipient's approved delivery address.",
    "The shipment is otherwise ready, but the approved delivery address is absent from all trusted customer records.",
    [{ name: "create_shipping_label", summary: "Create one shipment label.", method: "POST" }],
  );
  missingData.state.missingInformation = ["recipient's approved delivery address"];

  const missingCredential = caseInput(
    "confirm-missing-credential",
    "Register the approved device and record its external identifier on the asset record.",
    "The device data is complete and the target is configured, but no credential value exists for the target's declared credential alias.",
    [
      { name: "register_device", summary: "Register one approved device.", method: "POST" },
      { name: "update_asset", summary: "Record the external device identifier.", method: "PUT" },
    ],
  );
  missingCredential.state.configuredSecretAliases = [];

  const missingPermission = caseInput(
    "confirm-missing-permission",
    "Close the resolved incident in the external incident system.",
    "The incident is resolved, but customer configuration authorizes reads only and does not authorize the documented close operation.",
    [
      { name: "read_incident", summary: "Read the incident.", method: "GET" },
      { name: "close_incident", summary: "Close the resolved incident.", method: "POST" },
    ],
  );
  missingPermission.authority.allowedMethods = ["GET"];
  missingPermission.authority.writeAuthority = "denied";

  const missingApproval = caseInput(
    "confirm-missing-approval",
    "Submit the prepared production change after the required release approval.",
    "The change is prepared and policy permits it, but submit_production_change requires per-action approval and the approval list is empty.",
    [
      { name: "read_change", summary: "Read the prepared change.", method: "GET" },
      { name: "submit_production_change", summary: "Submit the prepared production change.", method: "POST" },
    ],
  );
  missingApproval.authority.writeAuthority = "per-action-approval";
  missingApproval.state.requiredApprovals = ["submit_production_change"];

  const current = caseInput(
    "confirm-current-capability",
    "Create the reviewed project task in the configured planning system.",
    "The task details are complete and configured-projects is healthy and exposes create_project_task.",
    [{ name: "create_project_task", summary: "Create one project task.", method: "POST" }],
  );
  current.state.availableCapabilities = [
    { key: "configured-projects", summary: "Configured planning actions.", actions: ["create_project_task"], status: "available" },
  ];

  const retry = caseInput(
    "confirm-retry",
    "Add the approved subscriber to the mailing list.",
    "The configured mailing-list capability exposes add_subscriber. Its only attempt ended in a runtime-classified retryable network timeout.",
    [{ name: "add_subscriber", summary: "Add one mailing-list subscriber.", method: "POST" }],
  );
  retry.state.availableCapabilities = [
    { key: "configured-mailing", summary: "Configured mailing actions.", actions: ["add_subscriber"], status: "transient-failure" },
  ];

  const policy = caseInput(
    "confirm-policy",
    "Send the selected medical notes to the external analysis service.",
    "The records and endpoint are known, but the customer's active data policy prohibits sending these medical notes to that service.",
    [{ name: "send_medical_notes", summary: "Send notes to the external service.", method: "POST" }],
  );
  policy.state.policyAllowsAction = false;

  const ambiguous = caseInput(
    "confirm-ambiguous",
    "Make the account ready for next week's launch.",
    "No externally verifiable completion criteria or required action are available, and trusted state cannot determine whether the broad goal is already satisfied.",
    [
      { name: "read_account", summary: "Read the account.", method: "GET" },
      { name: "update_account", summary: "Update an account field.", method: "PUT" },
    ],
  );
  ambiguous.state.goalSatisfied = null;

  return [
    { id: fieldVisit.context.workflowKey, input: fieldVisit, expectedDecision: "acquire-capability", expectedActions: ["find_appointment", "create_appointment", "update_work_order"] },
    { id: reservation.context.workflowKey, input: reservation, expectedDecision: "acquire-capability", expectedActions: ["find_stock_reservation", "create_stock_reservation", "update_transfer_request"] },
    { id: unavailable.context.workflowKey, input: unavailable, expectedDecision: "acquire-capability", expectedActions: ["find_invoice", "create_invoice", "update_fulfillment"] },
    { id: complete.context.workflowKey, input: complete, expectedDecision: "goal-complete", expectedActions: [] },
    { id: missingData.context.workflowKey, input: missingData, expectedDecision: "request-information", expectedActions: [] },
    { id: missingCredential.context.workflowKey, input: missingCredential, expectedDecision: "request-credential", expectedActions: [] },
    { id: missingPermission.context.workflowKey, input: missingPermission, expectedDecision: "request-permission", expectedActions: [] },
    { id: missingApproval.context.workflowKey, input: missingApproval, expectedDecision: "request-approval", expectedActions: [] },
    { id: current.context.workflowKey, input: current, expectedDecision: "continue-current", expectedActions: [] },
    { id: retry.context.workflowKey, input: retry, expectedDecision: "retry-current", expectedActions: [] },
    { id: policy.context.workflowKey, input: policy, expectedDecision: "policy-denied", expectedActions: [] },
    { id: ambiguous.context.workflowKey, input: ambiguous, expectedDecision: "insufficient-evidence", expectedActions: [] },
  ];
}
