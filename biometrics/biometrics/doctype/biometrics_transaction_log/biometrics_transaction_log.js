frappe.ui.form.on("Biometrics Transaction Log", {
	refresh(frm) {
		if (!frm.is_new() && !frm.doc.checkin_created && frm.doc.erpnext_employee) {
			frm.add_custom_button(__("Create Employee Checkin"), function () {
				frm.call("create_employee_checkin").then((r) => {
					if (r.message && r.message.success) {
						frappe.show_alert({
							message: __("Checkin {0} created", [r.message.checkin]),
							indicator: "green",
						});
						frm.reload_doc();
					} else {
						frappe.msgprint(r.message ? r.message.message : "Failed");
					}
				});
			});
		}

		// Show checkin link in headline
		if (frm.doc.checkin_created && frm.doc.employee_checkin) {
			frm.dashboard.set_headline(
				__("Employee Checkin: {0}", [
					`<a href="/app/employee-checkin/${frm.doc.employee_checkin}">${frm.doc.employee_checkin}</a>`,
				])
			);
		}

		// Render map link when coordinates are available
		_render_map_link(frm);
	},
});

function _render_map_link(frm) {
	const lat = frm.doc.latitude;
	const lng = frm.doc.longitude;
	const field = frm.get_field("map_link");
	if (!field) return;

	if (!lat || !lng || (lat === 0 && lng === 0)) {
		field.$wrapper.html("");
		return;
	}

	const gmaps = `https://www.google.com/maps?q=${lat},${lng}`;
	const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`;
	const coords = `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`;

	field.$wrapper.html(`
		<div style="margin:4px 0 8px; padding:8px 12px; background:var(--bg-color,#f8f9fa);
		            border:1px solid var(--border-color,#d1d8dd); border-radius:6px;
		            display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
			<span style="font-size:16px;">📍</span>
			<code style="font-size:12px; color:var(--text-muted);">${coords}</code>
			<a href="${gmaps}" target="_blank" rel="noopener"
			   style="font-size:13px; color:#4285f4; font-weight:500; text-decoration:none;">
				&#x1F5FA; Google Maps
			</a>
			<a href="${osm}" target="_blank" rel="noopener"
			   style="font-size:13px; color:#0d6efd; font-weight:500; text-decoration:none;">
				&#x1F30D; OpenStreetMap
			</a>
		</div>
	`);
}
