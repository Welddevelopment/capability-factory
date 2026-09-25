# Authority policy

- Allow reads: `getVehicle`, `listPickupSlots`, `listDispatchAudit` on `cedar_dispatch_sandbox`.
- Preauthorize exactly one `POST` through `createDraftPickupSlot` for the confirmed request, vehicle, and date.
- Credential aliases: `cedarActionBearer`, `cedarObserverBearer`.
- Maximum quantity per action: 1.
- Maximum actions per hour: 10.
- No monetary authority.
- Every other write action is forbidden.
- Reconcile independent external state before retry; blind retry is forbidden; maximum write attempts before handoff: 1.
- No approver is required inside this synthetic bounded scope.
