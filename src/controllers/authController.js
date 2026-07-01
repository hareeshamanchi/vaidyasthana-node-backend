const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Register User
const registerUser = async (req, res) => {
try {
const {
name,
email,
password,
phoneNumber,
address
} = req.body;

 
const existingUser =
  await User.findOne({ email });

if (existingUser) {
  return res.status(400).json({
    success: false,
    message: "User already exists"
  });
}

const salt =
  await bcrypt.genSalt(10);

const hashedPassword =
  await bcrypt.hash(
    password,
    salt
  );

const user =
  await User.create({
    name,
    email,
    password: hashedPassword,
    phoneNumber,
    address,
    role: "patient"
  });

res.status(201).json({
  success: true,
  message:
    "User registered successfully",
  user: {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role
  }
});
  

} catch (error) {
console.error(error);

  
res.status(500).json({
  success: false,
  message: "Server Error"
});
  

}
};

// Login User
const loginUser = async (req, res) => {
try {
const { email, password } =
req.body;

  
const user =
  await User.findOne({ email });

if (!user) {
  return res.status(400).json({
    success: false,
    message:
      "Invalid Credentials"
  });
}

const isMatch =
  await bcrypt.compare(
    password,
    user.password
  );

if (!isMatch) {
  return res.status(400).json({
    success: false,
    message:
      "Invalid Credentials"
  });
}

const token = jwt.sign(
  {
    id: user._id
  },
  process.env.JWT_SECRET,
  {
    expiresIn: "7d"
  }
);

res.status(200).json({
  success: true,
  token,
  user: {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role
  }
});
  

} catch (error) {
console.error(error);

  
res.status(500).json({
  success: false,
  message: "Server Error"
});
  

}
};

// Get Profile
const getProfile = async (
req,
res
) => {
try {
const user =
await User.findById(
req.user.id
).select("-password");

  
res.status(200).json(user);
  

} catch (error) {
console.error(error);


res.status(500).json({
  success: false,
  message: "Server Error"
});

}
};

module.exports = {
registerUser,
loginUser,
getProfile
};
