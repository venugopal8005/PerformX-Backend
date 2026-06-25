import { Agency, User } from "../../index.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { OAuth2Client } from "google-auth-library";
import { generateToken } from "../services/token.service.js";
import { cookieOptions } from "../config/cookieOptions.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (email = "") => email.toString().trim().toLowerCase();
const normalizeText = (value = "") => value.toString().trim();
const isValidEmail = (email = "") => EMAIL_PATTERN.test(normalizeEmail(email));
const idsMatch = (left, right) =>
  left && right && left.toString() === right.toString();
const hashInviteToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

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

const resolveGoogleAccessTokenProfile = async (accessToken) => {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Google access token could not be verified");
  }

  const payload = await response.json();

  if (!payload?.email || !payload?.sub || !payload?.name) {
    throw new Error("Google profile is missing required fields");
  }

  if (payload.email_verified === false || payload.email_verified === "false") {
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

  if (body.accessToken || body.access_token) {
    return resolveGoogleAccessTokenProfile(body.accessToken || body.access_token);
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

const getGoogleId = (user) => getUserField(user, "googleId", "google_id");

const googleIdQueryConditions = (googleId) => {
  if (!googleId) return [];

  const conditions = [];
  if (User.schema.path("googleId")) conditions.push({ googleId });
  if (User.schema.path("google_id")) conditions.push({ google_id: googleId });

  return conditions.length ? conditions : [{ googleId }];
};

const getWorkspaceSettings = async (agencyId) => {
  if (!agencyId || !mongoose.models.WorkspaceSettings) return null;

  return mongoose.models.WorkspaceSettings.findOne({ agency_id: agencyId })
    .select("logo_url")
    .lean();
};

const toAuthAgency = (agency, workspaceSettings = null) => {
  if (!agency) return null;

  return {
    id: agency._id,
    name: agency.name,
    slug: agency.slug,
    logo_url: workspaceSettings?.logo_url || null,
    logoUrl: workspaceSettings?.logo_url || null,
  };
};

const toAuthUser = (user, agency, workspaceSettings = null) => {
  const populatedAgency =
    user.agencyId && typeof user.agencyId === "object" && user.agencyId.name
      ? user.agencyId
      : agency;

  return {
    id: user._id,
    fullName: getUserField(user, "fullName", "full_name"),
    email: user.email,
    avatar: getUserField(user, "avatar", "avatar_url"),
    avatar_url: getUserField(user, "avatar", "avatar_url"),
    role: user.role,
    agencyId: getAgencyId(user),
    agency: toAuthAgency(populatedAgency, workspaceSettings),
  };
};

const sendAuthResponse = async (res, status, user, message, agency = null) => {
  const token = generateToken(buildAuthPayload(user));
  const authAgency =
    agency ||
    (user.agencyId && typeof user.agencyId === "object" && user.agencyId.name
      ? user.agencyId
      : await Agency.findById(getAgencyId(user)).select("name slug"));
  const workspaceSettings = await getWorkspaceSettings(getAgencyId(user));

  res.cookie("token", token, cookieOptions);

  return res.status(status).json({
    message,
    token,
    user: toAuthUser(user, authAgency, workspaceSettings),
  });
};

const setAgencyOwner = async (agency, userId) => {
  if (!agency || !userId || idsMatch(agency.created_by, userId)) return agency;

  agency.created_by = userId;
  await agency.save();
  return agency;
};

const ensureOwnerMembership = async (agency, user) => {
  const WorkspaceMember = mongoose.models.WorkspaceMember;
  if (!WorkspaceMember || !agency?._id || !user?._id) return null;

  return WorkspaceMember.findOneAndUpdate(
    {
      workspace_id: agency._id,
      user_id: user._id,
    },
    {
      $set: {
        role: "owner",
        status: "active",
        removed_at: null,
      },
      $setOnInsert: {
        workspace_id: agency._id,
        user_id: user._id,
        joined_at: user.createdAt || new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const findUsableInvite = async (rawToken) => {
  const WorkspaceInvite = mongoose.models.WorkspaceInvite;
  if (!WorkspaceInvite || !rawToken) return null;

  const invite = await WorkspaceInvite.findOne({
    token_hash: hashInviteToken(rawToken),
  });

  if (!invite || invite.status !== "pending") return null;

  if (invite.expires_at <= new Date()) {
    invite.status = "expired";
    await invite.save();
    return null;
  }

  return invite;
};

const acceptInviteForUser = async (invite, user) => {
  const WorkspaceMember = mongoose.models.WorkspaceMember;
  if (!WorkspaceMember || !invite || !user) return null;

  const membership = await WorkspaceMember.findOneAndUpdate(
    {
      workspace_id: invite.workspace_id,
      user_id: user._id,
    },
    {
      $set: {
        role: invite.role,
        status: "active",
        removed_at: null,
      },
      $setOnInsert: {
        workspace_id: invite.workspace_id,
        user_id: user._id,
        joined_at: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  invite.status = "accepted";
  invite.accepted_by_user_id = user._id;
  invite.accepted_at = new Date();
  await invite.save();

  return membership;
};

const findGoogleAuthUser = async ({ email, googleId }) => {
  const conditions = [{ email }, ...googleIdQueryConditions(googleId)];

  const users = await User.find({ $or: conditions }).limit(2);
  if (!users.length) return null;

  const emailUser = users.find((user) => user.email === email);
  const googleUser = users.find((user) => getGoogleId(user) === googleId);

  if (emailUser && googleUser && !idsMatch(emailUser._id, googleUser._id)) {
    const conflict = new Error(
      "This Google account is already linked to another user"
    );
    conflict.status = 409;
    throw conflict;
  }

  return emailUser || googleUser || users[0];
};

const applyGoogleProfile = (user, { avatar, email, googleId, name }) => {
  const existingGoogleId = getGoogleId(user);

  if (existingGoogleId && existingGoogleId !== googleId) {
    const conflict = new Error(
      "This email is already linked to another Google account"
    );
    conflict.status = 409;
    throw conflict;
  }

  user.email = email || user.email;
  user.fullName = user.fullName || name;
  user.googleId = user.googleId || googleId;
  user.avatar = user.avatar || avatar;
  return user;
};

const sendGoogleAgencyRequiredResponse = (res, { avatar, email, name }) =>
  res.status(400).json({
    message: "Agency name is required",
    requiresAgencyName: true,
    step: "agency_required",
    profile: {
      name,
      email,
      avatar,
    },
  });

export const register = async (req, res) => {
  try {
    const agencyName = normalizeText(req.body.agencyName);
    const fullName = normalizeText(req.body.fullName);
    const { password } = req.body;
    const email = req.body.email ? normalizeEmail(req.body.email) : "";
    const inviteToken = normalizeText(req.body.inviteToken);

    if (!email || !fullName || !password || (!agencyName && !inviteToken)) {
      return res.status(400).json({
        message: "Full name, email, password, and workspace context are required",
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

    if (inviteToken) {
      const invite = await findUsableInvite(inviteToken);
      if (!invite) {
        return res.status(400).json({ message: "Invitation is invalid or expired" });
      }

      if (invite.email !== email) {
        return res.status(403).json({
          message: `This invitation was sent to ${invite.email}. Please sign up with that email to accept it.`,
        });
      }

      const agency = await Agency.findById(invite.workspace_id);
      const user = await User.create({
        fullName,
        email,
        passwordHash: password,
        role: invite.role,
        agencyId: invite.workspace_id,
      });
      await acceptInviteForUser(invite, user);

      return sendAuthResponse(
        res,
        201,
        user,
        "Invitation accepted successfully",
        agency
      );
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
    await setAgencyOwner(agency, user._id);
    await ensureOwnerMembership(agency, user);

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
    const inviteToken = normalizeText(req.body.inviteToken);
    const profile = await resolveGoogleProfile(req.body);
    const { avatar, email, googleId, name } = profile;

    if (!email || !googleId || !name || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid Google name, email, and googleId are required",
      });
    }

    // Google signup/login uses the verified Google email as the identity key.
    const existingUser = await findGoogleAuthUser({ email, googleId });

    if (inviteToken) {
      const invite = await findUsableInvite(inviteToken);
      if (!invite) {
        return res.status(400).json({ message: "Invitation is invalid or expired" });
      }

      if (invite.email !== email) {
        return res.status(403).json({
          message: `This invitation was sent to ${invite.email}. Please sign in with that email to accept it.`,
        });
      }

      const agency = await Agency.findById(invite.workspace_id);

      if (existingUser) {
        applyGoogleProfile(existingUser, profile);
        existingUser.role = invite.role;
        existingUser.agencyId = invite.workspace_id;
        await existingUser.save();
        await acceptInviteForUser(invite, existingUser);

        return sendAuthResponse(
          res,
          200,
          existingUser,
          "Invitation accepted successfully",
          agency
        );
      }

      const invitedUser = await User.create({
        fullName: name,
        email,
        googleId,
        avatar,
        role: invite.role,
        agencyId: invite.workspace_id,
      });
      await acceptInviteForUser(invite, invitedUser);

      return sendAuthResponse(
        res,
        201,
        invitedUser,
        "Invitation accepted successfully",
        agency
      );
    }

    if (existingUser && getAgencyId(existingUser)) {
      applyGoogleProfile(existingUser, profile);
      await existingUser.save();

      return sendAuthResponse(res, 200, existingUser, "Login successful");
    }

    if (!agencyName) {
      return sendGoogleAgencyRequiredResponse(res, profile);
    }

    const agency = await Agency.create({ name: agencyName });

    if (existingUser) {
      applyGoogleProfile(existingUser, profile);
      existingUser.role = "owner";
      existingUser.agencyId = agency._id;
      await existingUser.save();
      await setAgencyOwner(agency, existingUser._id);
      await ensureOwnerMembership(agency, existingUser);

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
    await setAgencyOwner(agency, user._id);
    await ensureOwnerMembership(agency, user);

    return sendAuthResponse(
      res,
      201,
      user,
      "Google signup completed successfully"
    );
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }

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

    const workspaceSettings = await getWorkspaceSettings(getAgencyId(user));

    res.json({ user: toAuthUser(user, null, workspaceSettings) });
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
