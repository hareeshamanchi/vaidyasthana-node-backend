const Contact = require("../models/Contact");

// ==========================================
// Submit Contact Inquiry
// POST /api/contact
// ==========================================
const submitContactForm = async (req, res) => {
  try {
    const { name, email, query, phoneNumber } = req.body;

    if (!name || !email || !query) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and message query are required fields.",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const contact = await Contact.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phoneNumber: phoneNumber ? phoneNumber.trim() : "",
      query: query.trim(),
      ipAddress: req.ip || "",
      status: "New",
    });

    return res.status(201).json({
      success: true,
      message:
        "Thank you! Your message has been received. Our clinical support team will get in touch with you shortly.",
      contactId: contact._id,
    });
  } catch (error) {
    console.error("Submit Contact Error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to process contact submission at this moment.",
    });
  }
};

// ==========================================
// List Inquiries (Doctor / Admin)
// GET /api/contact
// ==========================================
const getInquiries = async (req, res) => {
  try {
    const inquiries = await Contact.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      inquiries,
    });
  } catch (error) {
    console.error("Get Inquiries Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve contact inquiries.",
    });
  }
};

module.exports = {
  submitContactForm,
  getInquiries,
};
