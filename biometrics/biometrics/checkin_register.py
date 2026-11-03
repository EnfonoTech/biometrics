# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""Monthly check-in register: each employee's first check-in of every day, grouped by department,
branch, designation or another Employee field (GROUP_BY).

Shared by the Monthly Check-in Register report, the Check-in Heatmap page and the Employee Checkin
calendar, so all three agree on what a day's check-in, "late" and "absent" mean:

- a punch belongs to the day of its shift (shift_start), else to its calendar date
- the day's check-in is its first punch that is not an OUT
- the check-in time is what matters; "late" is judged only for shifts with Enable Late Entry Marking
  on (after shift start + grace period). Flexible shifts leave it off, so their punches are plain
  "present", as are punches with no shift
- absent / leave come from submitted Attendance; holidays from the shift's or employee's Holiday List
"""

import calendar
from datetime import date

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_last_day, getdate

from erpnext.setup.doctype.employee.employee import get_holiday_list_for_employee

# cell states; the report, page and calendar colour on these
ONTIME, LATE, PRESENT = "ontime", "late", "present"
ABSENT, LEAVE, HALF_DAY, WFH = "absent", "leave", "half_day", "wfh"
HOLIDAY, WEEKLY_OFF = "holiday", "weekly_off"
MISSING, PENDING, FUTURE, INACTIVE = "missing", "pending", "future", "inactive"

CODES = {
	ABSENT: "A",
	LEAVE: "L",
	HALF_DAY: "HD",
	WFH: "WFH",
	PRESENT: "P",
	HOLIDAY: "H",
	WEEKLY_OFF: "WO",
	MISSING: "–",
}

ATTENDANCE_STATES = {"Absent": ABSENT, "On Leave": LEAVE, "Half Day": HALF_DAY, "Work From Home": WFH}

# "Group By" choices -> Employee field; "None" puts everyone in one group
GROUP_BY = {
	"Department": "department",
	"Branch": "branch",
	"Designation": "designation",
	"Employment Type": "employment_type",
	"Grade": "grade",
	"Shift": "default_shift",
	"Reports To": "reports_to",
	"None": None,
}


@frappe.whitelist()
def get_checkin_register(
	company, month, year, department=None, branch=None, employee=None, group_by="Department"
):
	frappe.has_permission("Employee Checkin", "read", throw=True)
	return get_register(company, month, year, department, branch, employee, group_by)


def get_register(
	company, month, year, department=None, branch=None, employee=None, group_by="Department"
):
	start = date(cint(year), cint(month), 1)
	end = getdate(get_last_day(start))
	today = getdate()
	days = [add_days(start, i) for i in range((end - start).days + 1)]

	employees = _get_employees(company, start, end, department, branch, employee)
	names = [e.name for e in employees]
	punches = _get_first_punches(names, start, end)
	attendance = _get_attendance(names, start, end)
	holidays = _get_holidays(employees, start, end)

	group_field = GROUP_BY.get(group_by or "Department", "department")
	group_label = _get_group_labeller(group_field, group_by, employees)

	groups = {}
	for emp in employees:
		cells = [
			_get_cell(emp, day, today, punches, attendance, holidays.get(emp.name, {})) for day in days
		]
		groups.setdefault(group_label(emp), []).append(
			{
				"employee": emp.name,
				"employee_name": emp.employee_name,
				"designation": emp.designation,
				"department": emp.department,
				"cells": cells,
				"stats": _get_stats([cells]),
			}
		)

	return {
		"month_label": f"{_(calendar.month_name[start.month])} {start.year}",
		"days": [
			{
				"day": d.day,
				"date": str(d),
				"weekday": _(calendar.day_abbr[d.weekday()]),
				"is_today": d == today,
			}
			for d in days
		],
		"groups": [
			{
				"group": label,
				"headcount": len(rows),
				"employees": rows,
				"stats": _get_stats([row["cells"] for row in rows]),
				"daily": _get_daily([row["cells"] for row in rows], len(days)),
			}
			for label, rows in sorted(groups.items())
		],
		"summary": {
			"employees": len(employees),
			**_get_stats([row["cells"] for rows in groups.values() for row in rows]),
		},
		"arrivals": _get_arrivals(groups),
	}


def _get_group_labeller(field, group_by, employees):
	if not field:
		return lambda emp: _("All Employees")
	if field == "reports_to":
		# show the manager's name, not their employee ID
		managers = list({e.reports_to for e in employees if e.reports_to}) or [""]
		names = dict(
			frappe.get_all(
				"Employee",
				filters={"name": ("in", managers)},
				fields=["name", "employee_name"],
				as_list=True,
			)
		)
		return lambda emp: names.get(emp.reports_to) or emp.reports_to or _("No Manager")
	missing = _("No {0}").format(_(group_by))
	return lambda emp: emp.get(field) or missing


def _get_employees(company, start, end, department, branch, employee):
	filters = [
		["company", "=", company],
		["date_of_joining", "<=", end],
		["status", "!=", "Inactive"],
	]
	if department:
		filters.append(["department", "descendants of (inclusive)", department])
	if branch:
		filters.append(["branch", "=", branch])
	if employee:
		filters.append(["name", "=", employee])

	# get_list, not get_all: an HR User restricted to some departments sees only those
	employees = frappe.get_list(
		"Employee",
		filters=filters,
		fields=[
			"name",
			"employee_name",
			"department",
			"designation",
			"branch",
			"employment_type",
			"grade",
			"reports_to",
			"status",
			"date_of_joining",
			"relieving_date",
			"default_shift",
		],
		order_by="employee_name",
	)
	# people who left during the month stay, for the days they worked
	return [
		e
		for e in employees
		if e.status != "Left" or (e.relieving_date and getdate(e.relieving_date) >= start)
	]


def get_late_grace_minutes():
	"""{shift: grace minutes}, None for shifts that do not mark late entry (flexible timings)."""
	return {
		s.name: cint(s.late_entry_grace_period) if s.enable_late_entry_marking else None
		for s in frappe.get_all(
			"Shift Type", fields=["name", "enable_late_entry_marking", "late_entry_grace_period"]
		)
	}


def first_punch_per_day(rows):
	"""Reduce checkins (ordered by time) to {(employee, day): first punch}, with the day's punch
	count and last punch. Later punches of the day do not change the check-in time."""
	grace = get_late_grace_minutes()
	first = {}
	for row in rows:
		day = getdate(row.shift_start or row.time)
		entry = first.get((row.employee, day))
		if not entry:
			entry = first[(row.employee, day)] = frappe._dict(row, day=day, punches=0, has_in=False)
		entry.punches += 1
		entry.last_time = row.time
		# an IN after a stray OUT is still the real check-in
		if row.log_type != "OUT" and not entry.has_in:
			entry.update(row, has_in=True)

	for entry in first.values():
		entry.state, entry.minutes = PRESENT, None
		if entry.shift_start:
			entry.minutes = round((entry.time - entry.shift_start).total_seconds() / 60)
			if grace.get(entry.shift) is not None:
				entry.state = LATE if entry.minutes > grace[entry.shift] else ONTIME
	return first


def _get_first_punches(employees, start, end):
	if not employees:
		return {}

	# a day's shift can start the evening before or the punch can fall after midnight
	rows = frappe.get_all(
		"Employee Checkin",
		filters=[
			["employee", "in", employees],
			["time", ">=", add_days(start, -1)],
			["time", "<", add_days(end, 2)],
		],
		fields=["name", "employee", "time", "log_type", "shift", "shift_start"],
		order_by="time",
	)
	return {
		key: entry for key, entry in first_punch_per_day(rows).items() if start <= entry.day <= end
	}


def _get_attendance(employees, start, end):
	if not employees:
		return {}

	rows = frappe.get_all(
		"Attendance",
		filters={
			"employee": ("in", employees),
			"attendance_date": ("between", [start, end]),
			"docstatus": 1,
		},
		fields=["name", "employee", "attendance_date", "status", "leave_type"],
	)
	return {(row.employee, getdate(row.attendance_date)): row for row in rows}


def _get_holidays(employees, start, end):
	"""{employee: {date: holiday row}}, using the default shift's Holiday List the way HRMS does."""
	shift_lists = dict(frappe.get_all("Shift Type", fields=["name", "holiday_list"], as_list=True))
	lists, by_list = {}, {}
	for emp in employees:
		holiday_list = shift_lists.get(emp.default_shift) or get_holiday_list_for_employee(
			emp.name, raise_exception=False
		)
		if holiday_list and holiday_list not in by_list:
			by_list[holiday_list] = {
				getdate(h.holiday_date): h
				for h in frappe.get_all(
					"Holiday",
					filters={"parent": holiday_list, "holiday_date": ("between", [start, end])},
					fields=["holiday_date", "weekly_off", "description"],
				)
			}
		lists[emp.name] = by_list.get(holiday_list, {})
	return lists


def _get_cell(emp, day, today, punches, attendance, holidays):
	if day < getdate(emp.date_of_joining) or (emp.relieving_date and day > getdate(emp.relieving_date)):
		return {"state": INACTIVE}

	punch = punches.get((emp.name, day))
	if punch:
		cell = {
			"state": punch.state,
			"time": punch.time.strftime("%H:%M"),
			"minute_of_day": punch.time.hour * 60 + punch.time.minute,
			"punches": punch.punches,
			"checkin": punch.name,
		}
		if punch.punches > 1:
			cell["last_time"] = punch.last_time.strftime("%H:%M")
		if punch.minutes is not None:
			cell["minutes"] = punch.minutes
		return cell

	record = attendance.get((emp.name, day))
	if record:
		state = ATTENDANCE_STATES.get(record.status, PRESENT)
		return {"state": state, "code": CODES[state], "attendance": record.name, "note": record.leave_type}

	holiday = holidays.get(day)
	if holiday:
		state = WEEKLY_OFF if holiday.weekly_off else HOLIDAY
		return {"state": state, "code": CODES[state], "note": holiday.description}

	if day > today:
		return {"state": FUTURE}
	if day == today:
		return {"state": PENDING}
	# a past working day with neither a punch nor attendance: auto attendance has not run (yet)
	return {"state": MISSING, "code": CODES[MISSING]}


def _get_stats(cell_rows):
	cells = [cell for row in cell_rows for cell in row]
	times = [c["minute_of_day"] for c in cells if "minute_of_day" in c]
	ontime = sum(c["state"] == ONTIME for c in cells)
	late = sum(c["state"] == LATE for c in cells)
	late_minutes = [c["minutes"] for c in cells if c["state"] == LATE]
	return {
		"present": len(times) + sum(c["state"] in (PRESENT, WFH) and "time" not in c for c in cells),
		"ontime": ontime,
		"late": late,
		"absent": sum(c["state"] == ABSENT for c in cells),
		"leave": sum(c["state"] in (LEAVE, HALF_DAY) for c in cells),
		"avg_in": format_minute_of_day(sum(times) / len(times)) if times else None,
		"earliest": format_minute_of_day(min(times)) if times else None,
		"latest": format_minute_of_day(max(times)) if times else None,
		"on_time_pct": flt(ontime * 100 / (ontime + late), 1) if ontime + late else None,
		"avg_late": round(sum(late_minutes) / len(late_minutes)) if late_minutes else None,
	}


def _get_daily(cell_rows, day_count):
	"""Per day for a group: how many checked in, were late or absent, and the average arrival."""
	daily = []
	for i in range(day_count):
		cells = [row[i] for row in cell_rows]
		times = [c["minute_of_day"] for c in cells if "minute_of_day" in c]
		offsets = [c["minutes"] for c in cells if "minutes" in c]
		daily.append(
			{
				"present": len(times),
				"late": sum(c["state"] == LATE for c in cells),
				"absent": sum(c["state"] == ABSENT for c in cells),
				"expected": sum(c["state"] not in (HOLIDAY, WEEKLY_OFF, INACTIVE, FUTURE) for c in cells),
				"avg_in": format_minute_of_day(sum(times) / len(times)) if times else None,
				"avg_offset": round(sum(offsets) / len(offsets)) if offsets else None,
			}
		)
	return daily


def _get_arrivals(groups):
	"""How many check-ins fell in each time slot of the day, per group: when people arrive."""
	times = {
		label: [c["minute_of_day"] for row in rows for c in row["cells"] if "minute_of_day" in c]
		for label, rows in groups.items()
	}
	every = [t for values in times.values() for t in values]
	if not every:
		return {"labels": [], "datasets": []}

	# 15-minute slots, widened when punches spread over many hours so the chart stays readable
	slot = 15
	while (max(every) - min(every)) / slot > 40:
		slot *= 2
	first, last = min(every) // slot, max(every) // slot
	return {
		"labels": [format_minute_of_day(i * slot) for i in range(first, last + 1)],
		"datasets": [
			{
				"name": label,
				"values": [sum(t // slot == i for t in values) for i in range(first, last + 1)],
			}
			for label, values in sorted(times.items())
		],
	}


def format_minute_of_day(minutes):
	minutes = round(minutes)
	return f"{minutes // 60:02d}:{minutes % 60:02d}"


@frappe.whitelist()
def get_calendar_events(doctype=None, start=None, end=None, field_map=None, filters=None, fields=None):
	"""Calendar of Employee Checkin: one event per employee per day (the first check-in), plus
	Absent and On Leave days, so a month reads as who came in when."""
	frappe.has_permission("Employee Checkin", "read", throw=True)
	filters = frappe.parse_json(filters) or []
	start, end = getdate(start), getdate(end)

	rows = frappe.get_list(
		"Employee Checkin",
		filters=[
			*filters,
			["Employee Checkin", "time", ">=", add_days(start, -1)],
			["Employee Checkin", "time", "<", add_days(end, 2)],
		],
		fields=["name", "employee", "employee_name", "time", "log_type", "shift", "shift_start"],
		order_by="time",
		limit_page_length=0,
	)

	events = []
	for entry in first_punch_per_day(rows).values():
		if not start <= entry.day <= end:
			continue
		late = f" ({_('{0} min late').format(entry.minutes)})" if entry.state == LATE else ""
		events.append(
			_event(
				"Employee Checkin",
				entry.name,
				entry.day,
				f"{entry.time.strftime('%H:%M')} {entry.employee_name}",
				entry.state,
				_("{0}: first check-in {1}{2}, {3} punch(es), last {4}").format(
					entry.employee_name,
					entry.time.strftime("%H:%M"),
					late,
					entry.punches,
					entry.last_time.strftime("%H:%M"),
				),
			)
		)

	# the calendar's filters are on Employee Checkin; carry over the ones Attendance also has
	attendance_filters = [
		["Attendance", f[1], f[2], f[3]]
		for f in filters
		# list filters are [doctype, field, operator, value(, hidden)]
		if len(f) >= 4 and f[1] in ("employee", "employee_name")
	]
	for row in frappe.get_list(
		"Attendance",
		filters=[
			*attendance_filters,
			["Attendance", "docstatus", "=", 1],
			["Attendance", "status", "in", ["Absent", "On Leave"]],
			["Attendance", "attendance_date", "between", [start, end]],
		],
		fields=["name", "employee_name", "attendance_date", "status", "leave_type"],
		limit_page_length=0,
	):
		state = ATTENDANCE_STATES[row.status]
		label = _("Absent") if state == ABSENT else (row.leave_type or _("On Leave"))
		events.append(
			_event(
				"Attendance",
				row.name,
				getdate(row.attendance_date),
				f"{label}: {row.employee_name}",
				state,
				f"{row.employee_name}: {label}",
			)
		)
	return events


# month cells show only a few events: absences and late arrivals first, then the rest by time
EVENT_RANK = {ABSENT: 0, LATE: 1, LEAVE: 2}


def _event(doctype, name, day, title, state, tooltip):
	return {
		"rank": EVENT_RANK.get(state, 3),
		"doctype": doctype,
		"name": name,
		"start": str(day),
		"end": str(day),
		"allDay": 1,
		"title": title,
		"state": state,
		"tooltip": tooltip,
		"convert_to_user_tz": 0,
		# read-only: the calendar lets submitted (docstatus > 0) events alone instead of dragging them
		"docstatus": 1,
	}
