const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const DEVICE_API_KEY = defineSecret("DEVICE_API_KEY");

exports.ingestReading = onRequest(
  { cors: true, secrets: [DEVICE_API_KEY] },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.status(405).send("POST only");

      const b = req.body || {};

      if (b.apiKey !== DEVICE_API_KEY.value()) {
        return res.status(403).send("Forbidden");
      }

      const deviceId = String(b.deviceId || "");
      if (!deviceId) return res.status(400).send("Missing deviceId");

      const payload = {
        Temperature: Number(b.Temperature),
        Humidity: Number(b.Humidity),
        Pressure: Number(b.Pressure),
        Light: Number(b.Light),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      };

      for (const k of ["Temperature", "Humidity", "Pressure", "Light"]) {
        if (Number.isNaN(payload[k])) delete payload[k];
      }

      await admin.firestore()
        .collection("public_readings")
        .doc(deviceId)
        .collection("data")
        .add(payload);

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false });
    }
  }
);
