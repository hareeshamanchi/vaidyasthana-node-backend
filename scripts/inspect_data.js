const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

async function inspectData() {
  const uri = process.env.MONGODB_URI;
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const admin = conn.connection.db.admin();
  const dbs = await admin.listDatabases();
  
  for (const d of dbs.databases) {
    if (d.name === "admin" || d.name === "local" || d.name === "sample_mflix") continue;
    const db = conn.connection.client.db(d.name);
    const cols = await db.listCollections().toArray();
    console.log(`\n=== Database: ${d.name} ===`);
    for (const c of cols) {
      const count = await db.collection(c.name).countDocuments();
      console.log(`Collection: ${c.name} (${count} docs)`);
      if (c.name === "appointments") {
        const appts = await db.collection(c.name).find({}).toArray();
        console.log(`Appointments in ${d.name}:`, appts.map(a => ({
          id: a._id,
          patientId: a.patientId,
          doctorId: a.doctorId,
          patientName: a.patientName,
          doctorName: a.doctorName,
          status: a.status,
          date: a.appointmentDate,
          slot: a.timeSlot
        })));
      }
    }
  }
  await mongoose.disconnect();
}

inspectData().catch(console.error);
