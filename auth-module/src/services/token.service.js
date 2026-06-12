import jwt from "jsonwebtoken";

export const generateToken = ({ userId, agencyId, role }) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }

  return jwt.sign(
    {
      userId,
      id: userId,
      agencyId,
      role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
};
