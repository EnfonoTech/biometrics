# apps/biometrics/biometrics/install.py
"""Imports the desk objects that Frappe's app sync never walks.

`frappe.model.sync.get_doc_files()` collects a fixed list of document types, and
`dashboard_chart` / `number_card` are not in it. The Dashboard Charts and Number Cards this app
ships were therefore never created by `bench install-app`, so the Biometrics workspace rendered
with an empty Overview band: its content blocks referenced four Number Cards and two Dashboard
Charts that did not exist on the site, and the desk stops laying out the page at the first one it
cannot resolve.

Importing the shipped JSON keeps a single source of truth — the files under
`biometrics/biometrics/{dashboard_chart,number_card}/` stay the definition, and this only replays
them onto the site. `force` is off so a record an implementer has since edited on the site is left
alone; a missing record is created.
"""

import glob
import os

import frappe
from frappe.modules.import_file import import_file_by_path

# document types Frappe's own app sync skips
UNSYNCED_DOC_TYPES = ("dashboard_chart", "number_card")


def after_install():
	import_desk_objects()


def after_migrate():
	import_desk_objects()


def import_desk_objects():
	"""Create any shipped Dashboard Chart / Number Card that is not on the site yet."""
	app_path = frappe.get_app_path("biometrics")

	for doc_type in UNSYNCED_DOC_TYPES:
		pattern = os.path.join(app_path, "**", doc_type, "*", "*.json")
		for path in sorted(glob.glob(pattern, recursive=True)):
			# a doctype folder holds one definition named after the folder; skip anything else
			if os.path.basename(path)[:-5] != os.path.basename(os.path.dirname(path)):
				continue

			try:
				import_file_by_path(path, force=False, reset_permissions=False)
			except Exception:
				# one bad file must not abort the install; the rest still need importing
				frappe.log_error(
					message=frappe.get_traceback(),
					title="Biometrics: could not import %s" % os.path.basename(path),
				)

	frappe.db.commit()
