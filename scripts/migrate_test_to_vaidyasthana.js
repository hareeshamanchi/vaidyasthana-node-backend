const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

async function migrateData() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI not found in environment.");
  }

  const conn = await mongoose.connect(uri, {
    dbName: "vaidyasthana",
    serverSelectionTimeoutMS: 15000,
  });

  const client = conn.connection.client;
  const dbTest = client.db("test");
  const dbVaidya = client.db("vaidyasthana");

  console.log("=== Migrating Users from test to vaidyasthana ===");
  const testUsers = await dbTest.collection("users").find({}).toArray();

  for (const user of testUsers) {
    const existing = await dbVaidya.collection("users").findOne({
      $or: [{ _id: user._id }, { email: user.email.toLowerCase() }],
    });

    if (!existing) {
      // For doctor pojitha, ensure verificationStatus is verified so patient appointments can be accepted
      if (user.email.toLowerCase() === "pojitha@gmail.com") {
        user.verificationStatus = "verified";
      }
      await dbVaidya.collection("users").insertOne(user);
      console.log(`Inserted user ${user.name} (${user.email}, ${user.role}) into vaidyasthana.users`);
    } else {
      // If pojitha already exists, ensure role is doctor and verificationStatus is verified
      if (user.email.toLowerCase() === "pojitha@gmail.com") {
        await dbVaidya.collection("users").updateOne(
          { _id: existing._id },
          { $set: { role: "doctor", verificationStatus: "verified" } }
        );
        console.log(`Updated pojitha in vaidyasthana.users to verified doctor`);
      } else {
        console.log(`User ${user.email} already exists in vaidyasthana.users`);
      }
    }
  }

  console.log("\n=== Migrating Appointments from test to vaidyasthana ===");
  const testAppts = await dbTest.collection("appointments").find({}).toArray();
  for (const appt of testAppts) {
    const existing = await dbVaidya.collection("appointments").findOne({ _id: appt._id });
    if (!existing) {
      await dbVaidya.collection("appointments").insertOne(appt);
      console.log(`Inserted appointment ${appt._id} (${appt.patientName} -> ${appt.doctorName})`);
    } else {
      console.log(`Appointment ${appt._id} already exists in vaidyasthana`);
    }
  }

  console.log("\n=== Migrating Insurances from test to vaidyasthana ===");
  const testInsurances = await dbTest.collection("insurances").find({}).toArray();
  for (const ins of testInsurances) {
    const existing = await dbVaidya.collection("insurances").findOne({ _id: ins._id });
    if (!existing) {
      await dbVaidya.collection("insurances").insertOne(ins);
      console.log(`Inserted insurance ${ins._id}`);
    }
  }

  console.log("\n=== Migrating Contacts from test to vaidyasthana ===");
  const testContacts = await dbTest.collection("contacts").find({}).toArray();
  for (const c of testContacts) {
    const existing = await dbVaidya.collection("contacts").findOne({ _id: c._id });
    if (!existing) {
      await dbVaidya.collection("contacts").insertOne(c);
      console.log(`Inserted contact ${c._id}`);
    }
  }

  console.log("\n=== Migration Finished Successfully ===");
  const finalUserCount = await dbVaidya.collection("users").countDocuments();
  const finalApptCount = await dbVaidya.collection("appointments").countDocuments();
  console.log(`vaidyasthana.users total: ${finalUserCount}`);
  console.log(`vaidyasthana.appointments total: ${finalApptCount}`);

  await mongoose.disconnect();
}

migrateData().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
