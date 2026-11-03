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
from frappe import _
from frappe.utils import cstr, get_datetime, getdate

API_ROLE = "Biometrics API"
ALLOWED_ROLES = {API_ROLE, "HR Manager", "System Manager"}
MAX_LOGS_PER_REQUEST = 500
# HRMS adds this comment to the Absent it marks for a working day with no check-ins
AUTO_ABSENT_COMMENT = "Employee was marked Absent due to missing Employee Checkins."


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
	settings = frappe.get_cached_doc("Biometrics Settings")

	results = [_push_one(index, log, employee_map, settings) for index, log in enumerate(logs)]

	summary = {"received": len(logs), "created": 0, "duplicate": 0, "failed": 0}
	for result in results:
		summary["failed" if result["status"] == "error" else result["status"]] += 1

	return {**summary, "results": results}


def _push_one(index, log, employee_map, settings):
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

	log_type = cstr(log.get("log_type")).strip().upper() or settings.default_log_type or ""
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
		# a resend can repair a punch that was stored before its day got marked Absent
		return _result(
			index, emp_code, raw_time, "duplicate", employee, existing, _reopen_auto_absent(existing)
		)

	# savepoint so a failed insert cannot leave partial rows behind for the rest of the batch
	frappe.db.savepoint("push_checkin")
	try:
		checkin = frappe.new_doc("Employee Checkin")
		checkin.employee = employee["name"]
		checkin.time = punch_time
		checkin.log_type = log_type
		checkin.device_id = cstr(log.get("device_id")).strip()[:140] or "API Push"
		if settings.office_latitude or settings.office_longitude:
			checkin.latitude = settings.office_latitude
			checkin.longitude = settings.office_longitude
		# HR Settings > Allow Geolocation Tracking demands GPS on every checkin, which only makes sense
		# for mobile check-ins; a machine punch is located by the machine, so skip that check here only
		checkin.validate_distance_from_shift_location = lambda: None
		checkin.insert(ignore_permissions=True)
	except Exception as e:
		frappe.db.rollback(save_point="push_checkin")
		frappe.clear_messages()
		return _error(index, emp_code, raw_time, cstr(e) or e.__class__.__name__)

	return _result(
		index, emp_code, raw_time, "created", employee, checkin.name, _reopen_auto_absent(checkin.name)
	)


def _reopen_auto_absent(checkin_name):
	"""Cancel the Absent HRMS auto-marked for this punch's day, so the next auto attendance run
	marks the day from the punch. Returns the cancelled Attendance, or None.

	Without this a late punch (backlog, client system offline) is only skipped by auto attendance,
	because the day already has an Attendance. Absents entered by HR or from leave are left alone.
	"""
	checkin = frappe.db.get_value(
		"Employee Checkin",
		checkin_name,
		["employee", "shift", "shift_start", "attendance"],
		as_dict=True,
	)
	if not checkin or checkin.attendance or not checkin.shift or not checkin.shift_start:
		return None

	attendance = frappe.db.get_value(
		"Attendance",
		{
			"employee": checkin.employee,
			"attendance_date": getdate(checkin.shift_start),
			"shift": checkin.shift,
			"status": "Absent",
			"docstatus": 1,
			"leave_type": ("is", "not set"),
		},
		"name",
	)
	if not attendance or not _is_auto_absent(attendance):
		return None

	frappe.db.savepoint("reopen_absent")
	try:
		doc = frappe.get_doc("Attendance", attendance)
		doc.flags.ignore_permissions = True
		doc.cancel()
		doc.add_comment(
			"Comment",
			text=f"Cancelled because a biometric punch ({checkin_name}) was pushed after the day was marked Absent.",
		)
		# auto attendance skips a punch it could not link while the Absent existed
		frappe.db.set_value("Employee Checkin", checkin_name, "skip_auto_attendance", 0)
	except Exception:
		frappe.db.rollback(save_point="reopen_absent")
		frappe.clear_messages()
		frappe.log_error(title=f"Biometrics push: could not cancel auto Absent {attendance}")
		return None

	return attendance


def _is_auto_absent(attendance):
	# the comment is stored in the system language at the time the scheduler marked it
	language = frappe.db.get_single_value("System Settings", "language")
	messages = list({AUTO_ABSENT_COMMENT, _(AUTO_ABSENT_COMMENT, lang=language)})
	return frappe.db.exists(
		"Comment",
		{
			"reference_doctype": "Attendance",
			"reference_name": attendance,
			"comment_type": "Comment",
			"content": ("in", messages),
		},
	)


def _result(index, emp_code, punch_time, status, employee, checkin, absent_cancelled=None):
	result = {
		"index": index,
		"emp_code": emp_code,
		"punch_time": punch_time,
		"status": status,
		"employee": employee["name"],
		"employee_name": employee["employee_name"],
		"checkin": checkin,
	}
	if absent_cancelled:
		result["absent_cancelled"] = absent_cancelled
	return result


def _error(index, emp_code, punch_time, message):
	return {
		"index": index,
		"emp_code": emp_code,
		"punch_time": punch_time,
		"status": "error",
		"message": message,
	}
