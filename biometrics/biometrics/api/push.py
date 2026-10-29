# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""
Inbound push API for clients whose biometric machines are not reachable from ERPNext.

The client's own system reads punches from its database and POSTs them here; each punch
becomes an Employee Checkin. The employee is matched on Employee.attendance_device_id,
the same key the pull sync uses.

Punches are written straight to Employee Checkin rather than Biometrics Transaction Log:
that log's biometrics_transaction_id is a unique Int (stored NOT NULL DEFAULT 0), so pushed
rows without a machine transaction id would collide with each other.
"""

import json

import frappe
from frappe.utils import cstr, get_datetime

API_ROLE = "Biometrics API"
ALLOWED_ROLES = {API_ROLE, "HR Manager", "System Manager"}
MAX_LOGS_PER_REQUEST = 500


@frappe.whitelist(methods=["POST"])
def push_checkins(logs=None):
	"""Create Employee Checkins from a batch of biometric punches.

	Safe to resend: a punch already stored for the same employee and time is reported
	as "duplicate" and not created again. One bad punch does not stop the rest.

	Args:
		logs: list of {"emp_code": str, "punch_time": "YYYY-MM-DD HH:MM:SS",
			"device_id": str (optional), "log_type": "IN" | "OUT" (optional)}
	"""
	if not ALLOWED_ROLES.intersection(frappe.get_roles()):
		frappe.throw(
			f"User {frappe.session.user} is not allowed to push check-ins. Assign the '{API_ROLE}' role.",
			frappe.PermissionError,
		)

	if isinstance(logs, str):
		try:
			logs = json.loads(logs)
		except ValueError:
			frappe.throw("'logs' must be a JSON array.")

	if not isinstance(logs, list) or not logs:
		frappe.throw("'logs' must be a non-empty array.")

	if len(logs) > MAX_LOGS_PER_REQUEST:
		frappe.throw(f"Send at most {MAX_LOGS_PER_REQUEST} logs per request (received {len(logs)}).")

	from biometrics.biometrics.api.sync import _build_employee_map

	employee_map = _build_employee_map()
	default_log_type = frappe.db.get_single_value("Biometrics Settings", "default_log_type") or ""

	results = [_push_one(index, log, employee_map, default_log_type) for index, log in enumerate(logs)]

	summary = {"received": len(logs), "created": 0, "duplicate": 0, "failed": 0}
	for result in results:
		summary["failed" if result["status"] == "error" else result["status"]] += 1

	return {**summary, "results": results}


def _push_one(index, log, employee_map, default_log_type):
	if not isinstance(log, dict):
		return _error(index, None, None, "Each log must be an object.")

	emp_code = cstr(log.get("emp_code")).strip()
	raw_time = cstr(log.get("punch_time")).strip()
	if not emp_code or not raw_time:
		return _error(index, emp_code, raw_time, "'emp_code' and 'punch_time' are required.")

	try:
		punch_time = get_datetime(raw_time)
	except Exception:
		return _error(index, emp_code, raw_time, "Invalid 'punch_time'. Use 'YYYY-MM-DD HH:MM:SS'.")

	log_type = cstr(log.get("log_type")).strip().upper() or default_log_type
	if log_type not in ("", "IN", "OUT"):
		return _error(index, emp_code, raw_time, "'log_type' must be 'IN' or 'OUT'.")

	employee = employee_map.get(emp_code)
	if not employee and emp_code.isdigit():
		# machines often zero-pad codes: "01001" should find device id "1001"
		employee = employee_map.get(str(int(emp_code)))
	if not employee:
		return _error(
			index, emp_code, raw_time,
			f"No active employee with Attendance Device ID '{emp_code}'.",
		)

	existing = frappe.db.exists("Employee Checkin", {"employee": employee["name"], "time": punch_time})
	if existing:
		return _result(index, emp_code, raw_time, "duplicate", employee, existing)

	# savepoint so a failed insert cannot leave partial rows behind for the rest of the batch
	frappe.db.savepoint("push_checkin")
	try:
		checkin = frappe.new_doc("Employee Checkin")
		checkin.employee = employee["name"]
		checkin.time = punch_time
		checkin.log_type = log_type
		checkin.device_id = cstr(log.get("device_id")).strip()[:140] or "API Push"
		checkin.insert(ignore_permissions=True)
	except Exception as e:
		frappe.db.rollback(save_point="push_checkin")
		frappe.clear_messages()
		return _error(index, emp_code, raw_time, cstr(e) or e.__class__.__name__)

	return _result(index, emp_code, raw_time, "created", employee, checkin.name)


def _result(index, emp_code, punch_time, status, employee, checkin):
	return {
		"index": index,
		"emp_code": emp_code,
		"punch_time": punch_time,
		"status": status,
		"employee": employee["name"],
		"employee_name": employee["employee_name"],
		"checkin": checkin,
	}


def _error(index, emp_code, punch_time, message):
	return {
		"index": index,
		"emp_code": emp_code,
		"punch_time": punch_time,
		"status": "error",
		"message": message,
	}
