const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

async function findPoj() {
  const uri = process.env.MONGODB_URI;
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const admin = conn.connection.db.admin();
  const dbs = await admin.listDatabases();
  
  for (const d of dbs.databases) {
    const db = conn.connection.client.db(d.name);
    const cols = await db.listCollections().toArray();
    if (cols.some((c) => c.name === "users")) {
      const match = await db.collection("users").find({
        $or: [
          { name: { $regex: "poj", $options: "i" } },
          { email: { $regex: "poj", $options: "i" } },
        ],
      }).toArray();
      if (match.length > 0) {
        console.log(`Found in db ${d.name}:`, match.map((m) => ({ id: m._id, name: m.name, email: m.email, role: m.role, verificationStatus: m.verificationStatus })));
      }
    }
  }
  await mongoose.disconnect();
}

findPoj().catch(console.error);
