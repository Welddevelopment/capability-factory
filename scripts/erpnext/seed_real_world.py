"""Seed or reset the genuine local ERPNext development world.

This file is executed inside the disposable ERPNext backend container with:
    bench --site frontend console < /tmp/seed_real_world.py

It uses only fictional data and prints one machine-readable JSON object at the end.
"""

from __future__ import annotations

import hashlib
import json
import os

import frappe
from erpnext.setup.setup_wizard.setup_wizard import setup_complete
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


COMPANY = "Capability Factory Development"
ABBR = "CFD"
ITEM_CODE = "DEMO-WIDGET"
WAREHOUSE = f"Stores - {ABBR}"
CASE_TO_ORDER = {
    "already-satisfied": "SO-REAL-0001",
    "first-build": "SO-REAL-0002",
    "fresh-session-reuse": "SO-REAL-0003",
    "permission-denial": "SO-REAL-0004",
    "incomplete-permission": "SO-REAL-0004",
    "invalid-target": "SO-REAL-0005",
    "lost-response-retry": "SO-REAL-0006",
}
ROLE_PERMISSIONS = {
    "CF Sandbox Full": {"read": 1, "write": 1, "create": 1, "submit": 1},
    "CF Sandbox Read Only": {"read": 1},
    "CF Sandbox Incomplete": {"read": 1, "write": 1},
}
USERS = {
    "full": {
        "email": "cf-full@example.invalid",
        "role": "CF Sandbox Full",
        "api_key": "cffullkey000001",
        "api_secret": "cffullsecret000001",
    },
    "read-only": {
        "email": "cf-read@example.invalid",
        "role": "CF Sandbox Read Only",
        "api_key": "cfreadkey000001",
        "api_secret": "cfreadsecret000001",
    },
    "incomplete": {
        "email": "cf-incomplete@example.invalid",
        "role": "CF Sandbox Incomplete",
        "api_key": "cfincompletekey1",
        "api_secret": "cfincompletesecret1",
    },
}


def ensure_company() -> None:
    if frappe.db.exists("Company", COMPANY):
        return
    setup_complete(
        frappe._dict(
            {
                "country": "United Kingdom",
                "fy_start_date": "2026-04-01",
                "fy_end_date": "2027-03-31",
                "company_name": COMPANY,
                "company_abbr": ABBR,
                "currency": "GBP",
                "chart_of_accounts": "Standard",
                "domain": "Distribution",
            }
        )
    )


def ensure_custom_fields() -> None:
    common_dispatch_fields = [
        {
            "fieldname": "custom_cf_dispatch_status",
            "label": "CF Dispatch Status",
            "fieldtype": "Select",
            "options": "Pending\nPrepared",
            "default": "Pending",
            "allow_on_submit": 1,
            "insert_after": "status",
        },
        {
            "fieldname": "custom_cf_carrier",
            "label": "CF Carrier",
            "fieldtype": "Data",
            "allow_on_submit": 1,
            "insert_after": "custom_cf_dispatch_status",
        },
        {
            "fieldname": "custom_cf_service",
            "label": "CF Service",
            "fieldtype": "Data",
            "allow_on_submit": 1,
            "insert_after": "custom_cf_carrier",
        },
        {
            "fieldname": "custom_cf_tracking_number",
            "label": "CF Tracking Number",
            "fieldtype": "Data",
            "allow_on_submit": 1,
            "insert_after": "custom_cf_service",
        },
        {
            "fieldname": "custom_cf_label_reference",
            "label": "CF Label Reference",
            "fieldtype": "Data",
            "allow_on_submit": 1,
            "insert_after": "custom_cf_tracking_number",
        },
    ]
    create_custom_fields(
        {
            "Sales Order": common_dispatch_fields,
            "Delivery Note": common_dispatch_fields
            + [
                {
                    "fieldname": "custom_cf_idempotency_key",
                    "label": "CF Idempotency Key",
                    "fieldtype": "Data",
                    "unique": 1,
                    "insert_after": "custom_cf_label_reference",
                }
            ],
        },
        update=True,
    )


def ensure_role(role: str) -> None:
    if not frappe.db.exists("Role", role):
        frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1}).insert(
            ignore_permissions=True
        )


def set_role_permissions() -> None:
    roles = list(ROLE_PERMISSIONS)
    frappe.db.delete("Custom DocPerm", {"role": ["in", roles]})
    read_dependencies = [
        "Company",
        "Customer",
        "Address",
        "Item",
        "Warehouse",
        "Bin",
        "Sales Order Item",
        "Delivery Note Item",
        "Account",
        "Cost Center",
        "Price List",
        "Currency",
        "UOM",
        "Item Group",
        "Territory",
        "Customer Group",
        "Fiscal Year",
    ]
    for role, permissions in ROLE_PERMISSIONS.items():
        ensure_role(role)
        for doctype in read_dependencies:
            frappe.get_doc(
                {
                    "doctype": "Custom DocPerm",
                    "parent": doctype,
                    "parenttype": "DocType",
                    "parentfield": "permissions",
                    "role": role,
                    "permlevel": 0,
                    "read": 1,
                    "select": 1,
                }
            ).insert(ignore_permissions=True)
        for doctype in ["Sales Order", "Delivery Note"]:
            values = {
                "doctype": "Custom DocPerm",
                "parent": doctype,
                "parenttype": "DocType",
                "parentfield": "permissions",
                "role": role,
                "permlevel": 0,
                **permissions,
            }
            if role == "CF Sandbox Incomplete" and doctype == "Delivery Note":
                values = {**values, "create": 0, "write": 0, "submit": 0}
            frappe.get_doc(values).insert(ignore_permissions=True)
    frappe.clear_cache()


def ensure_user(profile: str, definition: dict[str, str]) -> None:
    email = definition["email"]
    if frappe.db.exists("User", email):
        user = frappe.get_doc("User", email)
    else:
        user = frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": f"CF {profile}",
                "enabled": 1,
                "user_type": "System User",
                "send_welcome_email": 0,
            }
        )
        user.insert(ignore_permissions=True)
    user.enabled = 1
    user.api_key = definition["api_key"]
    user.api_secret = definition["api_secret"]
    current_roles = {row.role for row in user.roles}
    if definition["role"] not in current_roles:
        user.append("roles", {"role": definition["role"]})
    user.save(ignore_permissions=True)


def ensure_security() -> None:
    set_role_permissions()
    for profile, definition in USERS.items():
        ensure_user(profile, definition)


def delete_if_exists(doctype: str, name: str) -> None:
    if not frappe.db.exists(doctype, name):
        return
    doc = frappe.get_doc(doctype, name)
    if doc.docstatus == 1:
        doc.cancel()
    frappe.delete_doc(doctype, name, ignore_permissions=True, force=True)


def clear_synthetic_business_data() -> None:
    delivery_notes = frappe.get_all(
        "Delivery Note",
        filters={"custom_cf_tracking_number": ["like", "PF-SO-REAL-%"]},
        pluck="name",
    )
    for name in delivery_notes:
        delete_if_exists("Delivery Note", name)
    sales_orders = frappe.get_all(
        "Sales Order", filters={"name": ["like", "SO-REAL-%"]}, pluck="name"
    )
    for name in sales_orders:
        delete_if_exists("Sales Order", name)
    addresses = frappe.get_all(
        "Address", filters={"name": ["like", "ADDR-SO-REAL-%"]}, pluck="name"
    )
    for name in addresses:
        delete_if_exists("Address", name)
    customers = frappe.get_all(
        "Customer", filters={"name": ["like", "CUST-SO-REAL-%"]}, pluck="name"
    )
    for name in customers:
        delete_if_exists("Customer", name)


def ensure_item_and_stock() -> None:
    if not frappe.db.exists("Item", ITEM_CODE):
        leaf_group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
        frappe.get_doc(
            {
                "doctype": "Item",
                "item_code": ITEM_CODE,
                "item_name": "Fictional Demo Widget",
                "description": "Synthetic item for the local Capability Factory development world.",
                "item_group": leaf_group,
                "stock_uom": "Nos",
                "is_stock_item": 1,
                "is_sales_item": 1,
                "is_purchase_item": 1,
            }
        ).insert(ignore_permissions=True)
    bin_name = frappe.db.get_value("Bin", {"item_code": ITEM_CODE, "warehouse": WAREHOUSE}, "name")
    if not bin_name:
        bin_doc = frappe.get_doc(
            {
                "doctype": "Bin",
                "item_code": ITEM_CODE,
                "warehouse": WAREHOUSE,
                "actual_qty": 100,
                "reserved_qty": 1,
            }
        )
        bin_doc.flags.ignore_mandatory = True
        bin_doc.insert(ignore_permissions=True)
    else:
        frappe.db.set_value("Bin", bin_name, {"actual_qty": 100, "reserved_qty": 1})


def create_customer_and_address(order_id: str, valid_address: bool) -> str:
    customer_id = f"CUST-{order_id}"
    customer = frappe.get_doc(
        {
            "doctype": "Customer",
            "name": customer_id,
            "customer_name": f"Fictional Customer {order_id}",
            "customer_type": "Company",
            "customer_group": "Commercial",
            "territory": "United Kingdom",
        }
    )
    customer.flags.name_set = True
    customer.insert(ignore_permissions=True)
    if valid_address:
        address = frappe.get_doc(
            {
                "doctype": "Address",
                "name": f"ADDR-{order_id}",
                "address_title": customer_id,
                "address_type": "Shipping",
                "address_line1": "1 Test Yard",
                "city": "London",
                "country": "United Kingdom",
                "is_primary_address": 1,
                "is_shipping_address": 1,
                "links": [{"link_doctype": "Customer", "link_name": customer_id}],
            }
        )
        address.flags.name_set = True
        address.insert(ignore_permissions=True)
    return customer_id


def create_sales_order(order_id: str, customer_id: str):
    sales_order = frappe.get_doc(
        {
            "doctype": "Sales Order",
            "name": order_id,
            "company": COMPANY,
            "customer": customer_id,
            "transaction_date": "2026-07-26",
            "delivery_date": "2026-07-27",
            "currency": "GBP",
            "selling_price_list": "Standard Selling",
            "price_list_currency": "GBP",
            "conversion_rate": 1,
            "plc_conversion_rate": 1,
            "custom_cf_dispatch_status": "Pending",
            "items": [
                {
                    "item_code": ITEM_CODE,
                    "item_name": "Fictional Demo Widget",
                    "description": "Synthetic item for local testing.",
                    "delivery_date": "2026-07-27",
                    "qty": 1,
                    "uom": "Nos",
                    "stock_uom": "Nos",
                    "conversion_factor": 1,
                    "rate": 100,
                    "warehouse": WAREHOUSE,
                }
            ],
        }
    )
    sales_order.flags.name_set = True
    sales_order.insert(ignore_permissions=True)
    sales_order.submit()
    return sales_order


def create_satisfied_delivery(sales_order) -> None:
    from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note

    delivery = make_delivery_note(sales_order.name)
    delivery.name = f"DN-{sales_order.name}"
    delivery.flags.name_set = True
    delivery.custom_cf_dispatch_status = "Prepared"
    delivery.custom_cf_carrier = "ParcelFlow"
    delivery.custom_cf_service = "Standard Overnight"
    delivery.custom_cf_tracking_number = f"PF-{sales_order.name}"
    delivery.custom_cf_label_reference = f"LABEL-{sales_order.name}"
    delivery.custom_cf_idempotency_key = f"seed-{sales_order.name}"
    delivery.insert(ignore_permissions=True)
    frappe.db.set_value(
        "Sales Order",
        sales_order.name,
        {
            "custom_cf_dispatch_status": "Prepared",
            "custom_cf_carrier": "ParcelFlow",
            "custom_cf_service": "Standard Overnight",
            "custom_cf_tracking_number": f"PF-{sales_order.name}",
            "custom_cf_label_reference": f"LABEL-{sales_order.name}",
        },
        update_modified=False,
    )


def snapshot(order_id: str) -> dict:
    order_fields = [
        "name",
        "customer",
        "docstatus",
        "status",
        "custom_cf_dispatch_status",
        "custom_cf_carrier",
        "custom_cf_service",
        "custom_cf_tracking_number",
        "custom_cf_label_reference",
    ]
    note_fields = order_fields + ["custom_cf_idempotency_key"]
    return {
        "sales_order": frappe.db.get_value("Sales Order", order_id, order_fields, as_dict=True),
        "delivery_notes": frappe.get_all(
            "Delivery Note",
            filters={"custom_cf_tracking_number": f"PF-{order_id}"},
            fields=note_fields,
            order_by="name",
        ),
        "other_synthetic_orders": frappe.get_all(
            "Sales Order",
            filters=[["name", "like", "SO-REAL-%"], ["name", "!=", order_id]],
            fields=["name", "modified"],
            order_by="name",
        ),
        "item": frappe.db.get_value(
            "Item", ITEM_CODE, ["name", "item_name", "disabled"], as_dict=True
        ),
        "bin": frappe.db.get_value(
            "Bin",
            {"item_code": ITEM_CODE, "warehouse": WAREHOUSE},
            ["item_code", "warehouse", "actual_qty", "reserved_qty"],
            as_dict=True,
        ),
    }


def state_hash(value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def evidence_for_case(case_id: str) -> dict:
    if case_id not in CASE_TO_ORDER:
        raise ValueError(f"Unknown real ERPNext case: {case_id}")
    order_id = CASE_TO_ORDER[case_id]
    current = snapshot(order_id)
    return {
        "case_id": case_id,
        "sales_order_id": order_id,
        "state_hash": state_hash(current),
        "snapshot": current,
    }


def verify_case(case_id: str) -> dict:
    evidence = evidence_for_case(case_id)
    order_id = evidence["sales_order_id"]
    current = evidence["snapshot"]
    issues = []
    order = current["sales_order"]
    notes = current["delivery_notes"]
    should_be_prepared = case_id not in {
        "permission-denial",
        "incomplete-permission",
        "invalid-target",
    }
    if not order:
        issues.append({"code": "wrong-record", "message": f"Missing target {order_id}."})
    expected_count = 1 if should_be_prepared else 0
    if len(notes) < expected_count:
        issues.append({"code": "missing-write", "message": "Expected Delivery Note is missing."})
    if len(notes) > expected_count:
        issues.append(
            {
                "code": "duplicate-write",
                "message": f"Expected {expected_count} matching Delivery Notes; found {len(notes)}.",
            }
        )
    if order:
        expected_order_fields = {
            "custom_cf_dispatch_status": "Prepared" if should_be_prepared else "Pending",
            "custom_cf_carrier": "ParcelFlow" if should_be_prepared else None,
            "custom_cf_service": "Standard Overnight" if should_be_prepared else None,
            "custom_cf_tracking_number": f"PF-{order_id}" if should_be_prepared else None,
            "custom_cf_label_reference": f"LABEL-{order_id}" if should_be_prepared else None,
        }
        for field, expected in expected_order_fields.items():
            if order.get(field) != expected:
                issues.append(
                    {"code": "wrong-field", "message": f"Sales Order field {field} is incorrect."}
                )
    if notes:
        note = notes[0]
        expected_note_fields = {
            "customer": f"CUST-{order_id}",
            "custom_cf_dispatch_status": "Prepared",
            "custom_cf_carrier": "ParcelFlow",
            "custom_cf_service": "Standard Overnight",
            "custom_cf_tracking_number": f"PF-{order_id}",
            "custom_cf_label_reference": f"LABEL-{order_id}",
            "custom_cf_idempotency_key": (
                f"seed-{order_id}" if case_id == "already-satisfied" else f"delivery-{order_id}"
            ),
        }
        for field, expected in expected_note_fields.items():
            if note.get(field) != expected:
                issues.append(
                    {"code": "wrong-field", "message": f"Delivery Note field {field} is incorrect."}
                )
        note_items = frappe.get_all(
            "Delivery Note Item",
            filters={"parent": note["name"]},
            fields=["item_code", "qty", "warehouse", "against_sales_order"],
        )
        if len(note_items) != 1 or any(
            [
                note_items[0].item_code != ITEM_CODE,
                float(note_items[0].qty) != 1.0,
                note_items[0].warehouse != WAREHOUSE,
                note_items[0].against_sales_order != order_id,
            ]
        ):
            issues.append(
                {"code": "wrong-field", "message": "Delivery Note item does not match the source order."}
            )
    if current["other_synthetic_orders"]:
        issues.append(
            {"code": "forbidden-write", "message": "A non-target synthetic Sales Order remains."}
        )
    if current["item"] != {
        "name": ITEM_CODE,
        "item_name": "Fictional Demo Widget",
        "disabled": 0,
    }:
        issues.append({"code": "collateral-write", "message": "Synthetic Item changed."})
    bin_row = current["bin"] or {}
    if any(
        [
            bin_row.get("item_code") != ITEM_CODE,
            bin_row.get("warehouse") != WAREHOUSE,
            float(bin_row.get("actual_qty", 0)) != 100.0,
            float(bin_row.get("reserved_qty", 0)) != 1.0,
        ]
    ):
        issues.append({"code": "collateral-write", "message": "Synthetic stock Bin changed."})
    return {
        "case_id": case_id,
        "passed": not issues,
        "intended_writes": max(0, len(notes) - (1 if case_id == "already-satisfied" else 0)),
        "incorrect_side_effects": len([i for i in issues if i["code"] != "missing-write"]),
        "state_hash": evidence["state_hash"],
        "issues": issues,
    }


def main() -> None:
    case_id = os.environ.get("CF_CASE", "first-build")
    if case_id not in CASE_TO_ORDER:
        raise ValueError(f"Unknown real ERPNext case: {case_id}")
    ensure_company()
    ensure_custom_fields()
    ensure_security()
    clear_synthetic_business_data()
    ensure_item_and_stock()
    order_id = CASE_TO_ORDER[case_id]
    customer_id = create_customer_and_address(order_id, case_id != "invalid-target")
    sales_order = create_sales_order(order_id, customer_id)
    if case_id == "already-satisfied":
        create_satisfied_delivery(sales_order)
    frappe.db.commit()
    current = snapshot(order_id)
    print(
        json.dumps(
            {
                "ok": True,
                "case_id": case_id,
                "sales_order_id": order_id,
                "state_hash": state_hash(current),
                "snapshot": current,
                "credential_aliases": {
                    profile: f"ERPNEXT_REAL_{profile.upper().replace('-', '_')}_TOKEN"
                    for profile in USERS
                },
            },
            sort_keys=True,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
