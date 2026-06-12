import { Agency, User } from "../../index.js";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { generateToken } from "../services/token.service.js";
import { cookieOptions } from "../config/cookieOptions.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (email = "") => email.toString().trim().toLowerCase();
const normalizeText = (value = "") => value.toString().trim();
const isValidEmail = (email = "") => EMAIL_PATTERN.test(normalizeEmail(email));

const verifyGoogleCredential = async (credential) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;

  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required for Google signup");
  }

  const client = new OAuth2Client(googleClientId);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: googleClientId,
  });
  const payload = ticket.getPayload();

  if (!payload?.email || !payload?.sub || !payload?.name) {
    throw new Error("Google profile is missing required fields");
  }

  if (payload.email_verified === false) {
    throw new Error("Google email is not verified");
  }

  return {
    name: normalizeText(payload.name),
    email: normalizeEmail(payload.email),
    googleId: payload.sub,
    avatar: payload.picture || null,
  };
};

const resolveGoogleProfile = async (body = {}) => {
  if (body.credential) {
    return verifyGoogleCredential(body.credential);
  }

  return {
    name: normalizeText(body.name),
    email: normalizeEmail(body.email),
    googleId: normalizeText(body.googleId),
    avatar: body.avatar || null,
  };
};

const buildAuthPayload = (user) => ({
  userId: user._id.toString(),
  agencyId: getAgencyId(user)?.toString(),
  role: user.role,
});

const getAgencyRefPath = () =>
  User.schema.path("agencyId") ? "agencyId" : "agency_id";

const getAgencyId = (user) => {
  const agency = user?.agencyId || user?.agency_id;
  return agency?._id || agency;
};

const getUserField = (user, camelKey, snakeKey) =>
  user?.[camelKey] ?? user?.[snakeKey] ?? null;

const toAuthAgency = (agency) => {
  if (!agency) return null;

  return {
    id: agency._id,
    name: agency.name,
    slug: agency.slug,
  };
};

const toAuthUser = (user, agency) => {
  const populatedAgency =
    user.agencyId && typeof user.agencyId === "object" && user.agencyId.name
      ? user.agencyId
      : agency;

  return {
    id: user._id,
    fullName: getUserField(user, "fullName", "full_name"),
    email: user.email,
    avatar: getUserField(user, "avatar", "avatar_url"),
    role: user.role,
    agencyId: getAgencyId(user),
    agency: toAuthAgency(populatedAgency),
  };
};

const sendAuthResponse = async (res, status, user, message, agency = null) => {
  const token = generateToken(buildAuthPayload(user));
  const authAgency =
    agency ||
    (user.agencyId && typeof user.agencyId === "object" && user.agencyId.name
      ? user.agencyId
      : await Agency.findById(getAgencyId(user)).select("name slug"));

  res.cookie("token", token, cookieOptions);

  return res.status(status).json({
    message,
    token,
    user: toAuthUser(user, authAgency),
  });
};

export const register = async (req, res) => {
  try {
    const agencyName = normalizeText(req.body.agencyName);
    const fullName = normalizeText(req.body.fullName);
    const { password } = req.body;
    const email = req.body.email ? normalizeEmail(req.body.email) : "";

    if (!agencyName || !email || !fullName || !password) {
      return res.status(400).json({
        message: "Agency name, full name, email, and password are required",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        message: "Enter a valid email address",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    // Email signup creates the first workspace and makes the user its owner.
    const agency = await Agency.create({ name: agencyName });
    const user = await User.create({
      fullName,
      email,
      passwordHash: password,
      role: "owner",
      agencyId: agency._id,
    });

    return sendAuthResponse(
      res,
      201,
      user,
      "User registered successfully",
      agency
    );
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Agency or user already exists" });
    }

    console.error("Registration failed", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const login = async (req, res) => {
  try {
    const { password } = req.body;
    const email = req.body.email ? normalizeEmail(req.body.email) : "";

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }

    const user = await User.findOne({ email }).select("+passwordHash +password_hash");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    return sendAuthResponse(res, 200, user, "Login successful");
  } catch (err) {
    console.error("Login failed", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const googleSignup = async (req, res) => {
  try {
    const agencyName = normalizeText(req.body.agencyName);
    const { avatar, email, googleId, name } = await resolveGoogleProfile(req.body);

    if (!email || !googleId || !name || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid Google name, email, and googleId are required",
      });
    }

    // Google signup/login uses the verified Google email as the identity key.
    const existingUser = await User.findOne({ email });
    if (existingUser?.agencyId) {
      let shouldSave = false;

      if (!existingUser.googleId) {
        existingUser.googleId = googleId;
        shouldSave = true;
      }

      if (!existingUser.avatar && avatar) {
        existingUser.avatar = avatar;
        shouldSave = true;
      }

      if (shouldSave) {
        await existingUser.save();
      }

      return sendAuthResponse(res, 200, existingUser, "Login successful");
    }

    if (!agencyName) {
      return res.status(400).json({
        message: "Agency name is required",
        requiresAgencyName: true,
      });
    }

    const agency = await Agency.create({ name: agencyName });

    if (existingUser) {
      existingUser.fullName = existingUser.fullName || name;
      existingUser.googleId = existingUser.googleId || googleId;
      existingUser.avatar = existingUser.avatar || avatar;
      existingUser.role = existingUser.role || "owner";
      existingUser.agencyId = agency._id;
      await existingUser.save();

      return sendAuthResponse(
        res,
        200,
        existingUser,
        "Google signup completed successfully"
      );
    }

    const user = await User.create({
      fullName: name,
      email,
      googleId,
      avatar,
      role: "owner",
      agencyId: agency._id,
    });

    return sendAuthResponse(
      res,
      201,
      user,
      "Google signup completed successfully"
    );
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Agency or user already exists" });
    }

    console.error("Google signup failed", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const me = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const user = await User.findById(req.user.userId || req.user.id).populate(
      getAgencyRefPath(),
      "name slug"
    );

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    res.json({ user: toAuthUser(user) });
  } catch (err) {
    console.error("Auth check failed", err);
    res.status(500).json({ message: "Server error" });
  }
};

// LOGOUT
export const logout = (req, res) => {
  res.cookie("token", "", {
    ...cookieOptions,
    maxAge: 0,
  });

  res.status(200).json({ message: "Logged out" });
};

export const refresh = (req, res) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const newToken = generateToken({
      userId: decoded.userId || decoded.id,
      agencyId: decoded.agencyId,
      role: decoded.role,
    });

    res.cookie("token", newToken, cookieOptions);

    res.json({ message: "Token refreshed" });
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
