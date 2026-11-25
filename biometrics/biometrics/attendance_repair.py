# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""
Re-mark attendance for days that receive a punch after HRMS has already marked them.

HRMS auto attendance only reads check-ins that are not linked to an Attendance and not
flagged skip_auto_attendance, and it never revisits a day that already has an Attendance.
A punch that reaches ERPNext late (missed by an earlier sync, backfilled, re-swept) therefore
leaves its day as it was: Absent, or Present with 0 working hours from a single punch.

For each day touched by such punches, this cancels the Attendance that auto attendance made
(never one entered by HR, from a leave, or from an Attendance Request) and marks the day again
from all of its check-ins, with HRMS' own rules. A day whose shift is not processed yet, or
that has no Attendance, is left to the next auto attendance run.

Override mode (manual backfill with "Override existing attendance"): every day with check-ins
is re-marked, also replacing attendance entered by hand and marking days that have none.
Attendance from a leave or an Attendance Request is never replaced. A day whose attendance
already matches its check-ins is left as it is.
"""

from contextlib import contextmanager

import frappe
from frappe import _
from frappe.utils import flt, get_datetime

# HRMS adds this comment to the Absent it marks for a working day with no check-ins
AUTO_ABSENT_COMMENT = "Employee was marked Absent due to missing Employee Checkins."

# the fields ShiftType.get_employee_checkins reads, which ShiftType.get_attendance expects
CHECKIN_FIELDS = [
	"name",
	"employee",
	"log_type",
	"time",
	"shift",
	"shift_start",
	"shift_end",
	"shift_actual_start",
	"shift_actual_end",
	"device_id",
]


def remark_attendance(from_date, to_date, employees=None, override=False):
	"""Re-mark the attendance of every day in [from_date, to_date] that has check-ins.

	Check-ins that never got a shift (a Shift Assignment created after the punches) are
	stamped with their shift first, so they count.
	"""
	filters = {"time": ("between", [f"{from_date} 00:00:00", f"{to_date} 23:59:59"])}
	if employees:
		filters["employee"] = ("in", list(employees))

	for name in frappe.get_all(
		"Employee Checkin",
		filters={**filters, "shift": ("is", "not set"), "attendance": ("is", "not set")},
		pluck="name",
	):
		_stamp_shift(name)

	return repair_attendance_for_checkins(frappe.get_all("Employee Checkin", filters=filters, pluck="name"), override)


def _stamp_shift(checkin_name):
	checkin = frappe.get_doc("Employee Checkin", checkin_name)
	try:
		checkin.fetch_shift()
	except frappe.ValidationError:
		frappe.clear_messages()
		return
	if checkin.shift:
		frappe.db.set_value(
			"Employee Checkin",
			checkin_name,
			{
				"shift": checkin.shift,
				"offshift": 0,
				"shift_start": checkin.shift_start,
				"shift_end": checkin.shift_end,
				"shift_actual_start": checkin.shift_actual_start,
				"shift_actual_end": checkin.shift_actual_end,
			},
			update_modified=False,
		)


def repair_attendance_for_checkins(checkin_names, override=False):
	"""Re-mark every already-marked day that the given check-ins belong to.

	Returns {"cancelled": [...], "marked": [...], "unchanged": int}.
	One day failing does not stop the others; it keeps its old Attendance and is logged.
	"""
	result = {"cancelled": [], "marked": [], "unchanged": 0}
	if not checkin_names or not frappe.db.table_exists("Attendance"):
		return result

	rows = frappe.get_all(
		"Employee Checkin",
		filters={"name": ("in", list(checkin_names))},
		fields=["employee", "shift", "shift_start"],
	)
	days = sorted({(r.employee, r.shift, get_datetime(r.shift_start)) for r in rows if r.shift and r.shift_start})

	with _as_administrator():
		for employee, shift, shift_start in days:
			frappe.db.savepoint("biometrics_repair_day")
			try:
				repaired = _repair_day(employee, shift, shift_start, override)
			except Exception:
				frappe.db.rollback(save_point="biometrics_repair_day")
				frappe.log_error(title="Biometrics: could not re-mark attendance of " + employee + " on " + str(shift_start.date()))
				repaired = None
			finally:
				frappe.clear_messages()

			if repaired == "unchanged":
				result["unchanged"] += 1
			elif repaired:
				if repaired[0]:
					result["cancelled"].append(repaired[0])
				result["marked"].append(repaired[1])

	return result


def _repair_day(employee, shift, shift_start, override=False):
	"""Returns (cancelled attendance or None, new attendance), "unchanged", or None when the
	day is left alone."""
	shift_type = frappe.get_doc("Shift Type", shift)
	attendance_date = shift_start.date()

	if not override and (not shift_type.enable_auto_attendance or not shift_type.last_sync_of_checkin):
		return None

	day_logs = _day_checkins(employee, shift, shift_start, unlinked_only=False)
	if not day_logs:
		return None

	# shift not over yet (for auto attendance: not processed yet): leave the day to auto attendance
	shift_over_at = get_datetime() if override else get_datetime(shift_type.last_sync_of_checkin)
	if get_datetime(day_logs[0].shift_actual_end) >= shift_over_at:
		return None

	if not shift_type.should_mark_attendance(employee, attendance_date):
		return None

	attendance = frappe.db.get_value(
		"Attendance",
		{"employee": employee, "attendance_date": attendance_date, "docstatus": 1},
		[
			"name", "status", "shift", "leave_type", "leave_application", "attendance_request",
			"working_hours", "late_entry", "early_exit",
		],
		as_dict=True,
	)
	if attendance:
		if _is_protected(attendance):
			return None
		if not override and (
			(attendance.shift and attendance.shift != shift) or not _is_auto_attendance(attendance)
		):
			return None
		if _matches_checkins(attendance, shift_type, day_logs):
			return "unchanged"
	elif not override:
		return None

	if attendance:
		old = frappe.get_doc("Attendance", attendance.name)
		old.flags.ignore_permissions = True
		old.cancel()  # also unlinks its check-ins
	else:
		old = None

	# auto attendance flags a punch it could not link while the day already had an Attendance
	frappe.db.set_value(
		"Employee Checkin",
		{"name": ("in", [log.name for log in day_logs]), "attendance": ("is", "not set")},
		"skip_auto_attendance",
		0,
		update_modified=False,
	)

	from hrms.hr.doctype.employee_checkin.employee_checkin import mark_attendance_and_link_log

	logs = _day_checkins(employee, shift, shift_start, unlinked_only=True)
	status, working_hours, late_entry, early_exit, in_time, out_time = shift_type.get_attendance(logs)
	new = mark_attendance_and_link_log(
		logs, status, attendance_date, working_hours, late_entry, early_exit, in_time, out_time, shift_type.name
	)
	if not new:
		# keep the old Attendance rather than leave the day unmarked
		raise Exception("HRMS did not mark " + employee + " on " + str(attendance_date) + " (status " + str(status) + ")")

	if old:
		old.add_comment(
			"Comment",
			text=_("Cancelled by Biometrics: re-marked from the day's biometric check-ins as:") + " " + new.name,
		)
	return (old.name if old else None), new.name


def _is_protected(attendance):
	"""Attendance that belongs to a leave or an Attendance Request is never replaced."""
	return bool(
		attendance.status == "On Leave"
		or attendance.leave_type
		or attendance.leave_application
		or attendance.attendance_request
	)


def _matches_checkins(attendance, shift_type, day_logs):
	"""True when every check-in is already linked to this attendance and HRMS would mark the
	same result from them, so re-marking would change nothing."""
	if any(log_attendance != attendance.name for log_attendance in _linked_attendance(day_logs)):
		return False
	status, working_hours, late_entry, early_exit, _in, _out = shift_type.get_attendance(day_logs)
	return (
		status == attendance.status
		and abs(flt(working_hours) - flt(attendance.working_hours)) < 0.01
		and bool(late_entry) == bool(attendance.late_entry)
		and bool(early_exit) == bool(attendance.early_exit)
	)


def _linked_attendance(day_logs):
	return frappe.get_all(
		"Employee Checkin", filters={"name": ("in", [log.name for log in day_logs])}, pluck="attendance"
	)


def _day_checkins(employee, shift, shift_start, unlinked_only):
	filters = {"employee": employee, "shift": shift, "shift_start": shift_start, "offshift": 0}
	if unlinked_only:
		filters.update({"attendance": ("is", "not set"), "skip_auto_attendance": 0})
	return frappe.get_all("Employee Checkin", filters=filters, fields=CHECKIN_FIELDS, order_by="time")


def _is_auto_attendance(attendance):
	"""Made by auto attendance: from check-ins, or HRMS' Absent for a day with none."""
	if attendance.leave_type or attendance.leave_application or attendance.attendance_request:
		return False
	if frappe.db.exists("Employee Checkin", {"attendance": attendance.name}):
		return True
	return attendance.status == "Absent" and _has_auto_absent_comment(attendance.name)


def _has_auto_absent_comment(attendance):
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


@contextmanager
def _as_administrator():
	"""Auto attendance runs as Administrator; cancel and re-mark under the same user."""
	user = frappe.session.user
	if user == "Administrator":
		yield
		return
	frappe.set_user("Administrator")
	try:
		yield
	finally:
		frappe.set_user(user)
