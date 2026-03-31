import { User } from "../../index.js";
import jwt from "jsonwebtoken";
import { generateToken } from "../services/token.service.js";
import { cookieOptions } from "../config/cookieOptions.js";

// REGISTER
export const register = async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json({ message: "All fields required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    const user = await User.create({ email, password, displayName });

    const token = generateToken({
      id: user._id,
      name: user.displayName,
      email: user.email,
    });

    res.cookie("token", token, cookieOptions);

    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// LOGIN
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken({
      id: user._id,
      name: user.displayName,
      email: user.email,
    });

    res.cookie("token", token, cookieOptions);

    res.status(200).json({ message: "Login successful" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ME
export const me = (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  res.json({ user: req.user });
};

// LOGOUT
export const logout = (req, res) => {
  res.cookie("token", "", {
    ...cookieOptions,
    maxAge: 0,
  });

  res.status(200).json({ message: "Logged out" });
};

// REFRESH
export const refresh = (req, res) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const newToken = generateToken({ id: decoded.id });

    res.cookie("token", newToken, cookieOptions);

    res.json({ message: "Token refreshed" });
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
