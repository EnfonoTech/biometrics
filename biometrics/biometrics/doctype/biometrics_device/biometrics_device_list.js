frappe.listview_settings["Biometrics Device"] = {
    add_fields: ["biometrics_device_id", "ip_address", "status", "serial_number"],
    get_indicator: function (doc) {
        if (doc.status === "Online") {
            return [__("Online"), "green", "status,=,Online"];
        } else if (doc.status === "Offline") {
            return [__("Offline"), "red", "status,=,Offline"];
        } else {
            return [__("Unknown"), "gray", "status,=,Unknown"];
        }
    },
};
