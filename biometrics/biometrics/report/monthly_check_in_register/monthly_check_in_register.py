# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""Each employee's first check-in time for every day of a month, grouped by the Group By filter
(department, branch, designation...).

The check-in time is the point; lateness columns appear only with the Highlight Late filter, and
only shifts with Enable Late Entry Marking are judged at all. Group rows show, per day, how many
of the people expected that day checked in. The data comes from
biometrics.biometrics.checkin_register, which the Check-in Heatmap page and the Employee Checkin
calendar share.
"""

import frappe
from frappe import _

from biometrics.biometrics.checkin_register import get_register


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not (filters.company and filters.month and filters.year):
		return [], []

	register = get_register(
		filters.company,
		filters.month,
		filters.year,
		filters.department,
		filters.branch,
		filters.employee,
		filters.group_by,
	)
	highlight_late = bool(filters.highlight_late)
	return (
		get_columns(register["days"], highlight_late, filters.group_by),
		get_data(register),
		None,
		get_chart(register),
		get_summary(register["summary"], highlight_late),
	)


def get_columns(days, highlight_late, group_by):
	label = _("Employee") if group_by == "None" else f"{_(group_by or 'Department')} / {_('Employee')}"
	columns = [
		{"label": label, "fieldname": "label", "fieldtype": "Data", "width": 220},
		{"label": _("Employee"), "fieldname": "employee", "fieldtype": "Link", "options": "Employee", "width": 120},
	]
	columns += [
		{
			"label": f"{d['day']} {d['weekday'][:2]}",
			"fieldname": f"d{d['day']}",
			"fieldtype": "Data",
			"width": 72,
			"align": "center",
		}
		for d in days
	]
	columns += [
		{"label": _("Avg Check-in"), "fieldname": "avg_in", "fieldtype": "Data", "width": 105},
		{"label": _("Earliest"), "fieldname": "earliest", "fieldtype": "Data", "width": 85},
		{"label": _("Latest"), "fieldname": "latest", "fieldtype": "Data", "width": 80},
		{"label": _("Present"), "fieldname": "present", "fieldtype": "Int", "width": 80},
		{"label": _("Absent"), "fieldname": "absent", "fieldtype": "Int", "width": 75},
		{"label": _("Leave"), "fieldname": "leave", "fieldtype": "Int", "width": 70},
	]
	if highlight_late:
		columns += [
			{"label": _("Late"), "fieldname": "late", "fieldtype": "Int", "width": 70},
			{"label": _("On Time %"), "fieldname": "on_time_pct", "fieldtype": "Percent", "width": 95},
			{"label": _("Avg Late (min)"), "fieldname": "avg_late", "fieldtype": "Int", "width": 110},
		]
	return columns


def get_data(register):
	data = []
	for group in register["groups"]:
		row = {"label": group["group"], "indent": 0, "row_type": "group", **group["stats"]}
		for d, day in zip(register["days"], group["daily"]):
			key = f"d{d['day']}"
			if day["expected"]:
				row[key] = f"{day['present']}/{day['expected']}"
				row[f"{key}_state"] = "group"
				row[f"{key}_tip"] = _("{0} of {1} checked in, {2} absent{3}").format(
					day["present"],
					day["expected"],
					day["absent"],
					_(", average {0}").format(day["avg_in"]) if day["avg_in"] else "",
				)
		data.append(row)

		for emp in group["employees"]:
			row = {
				"label": emp["employee_name"],
				"employee": emp["employee"],
				"parent_label": group["group"],
				"indent": 1,
				"row_type": "employee",
				**emp["stats"],
			}
			for d, cell in zip(register["days"], emp["cells"]):
				key = f"d{d['day']}"
				row[key] = cell.get("time") or cell.get("code") or ""
				row[f"{key}_state"] = cell["state"]
				row[f"{key}_tip"] = get_cell_tip(cell)
			data.append(row)
	return data


def get_cell_tip(cell):
	if "time" in cell:
		parts = [_("First check-in {0}").format(cell["time"])]
		if cell.get("minutes") is not None:
			minutes = cell["minutes"]
			parts.append(
				_("{0} min after shift start").format(minutes)
				if minutes > 0
				else _("{0} min before shift start").format(-minutes)
			)
		if cell.get("last_time"):
			parts.append(_("{0} punches, last {1}").format(cell["punches"], cell["last_time"]))
		return ", ".join(parts)
	return cell.get("note") or ""


def get_chart(register):
	"""When people arrive: check-ins per time slot of the day, stacked by group."""
	arrivals = register["arrivals"]
	if not arrivals["labels"]:
		return None
	return {
		"title": _("Arrival times"),
		"data": arrivals,
		"type": "bar",
		"barOptions": {"stacked": 1},
	}


def get_summary(summary, highlight_late):
	cards = [
		{"label": _("Employees"), "value": summary["employees"], "datatype": "Int", "indicator": "Blue"},
		{"label": _("Avg Check-in"), "value": summary["avg_in"] or "-", "datatype": "Data", "indicator": "Blue"},
		{"label": _("Earliest"), "value": summary["earliest"] or "-", "datatype": "Data", "indicator": "Green"},
		{"label": _("Latest"), "value": summary["latest"] or "-", "datatype": "Data", "indicator": "Orange"},
		{
			"label": _("Absent / Leave Days"),
			"value": f"{summary['absent']} / {summary['leave']}",
			"datatype": "Data",
			"indicator": "Red",
		},
	]
	if highlight_late:
		cards += [
			{
				"label": _("On Time"),
				"value": f"{summary['on_time_pct']}%" if summary["on_time_pct"] is not None else "-",
				"datatype": "Data",
				"indicator": "Green",
			},
			{"label": _("Late Arrivals"), "value": summary["late"], "datatype": "Int", "indicator": "Orange"},
		]
	return cards
