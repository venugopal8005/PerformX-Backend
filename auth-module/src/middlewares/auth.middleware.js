import jwt from "jsonwebtoken";

export const protect = (req, res, next) => {
  console.log("Auth middleware called");
  const token = req.cookies?.token;
//  console.log(token);
  if (!token) {
    console.log("No token provided");
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Token verified successfully");
    req.user = decoded;
    next();
  } catch { 
    console.log("Token verification failed");
    return res.status(401).json({ message: "Invalid token" });
  }
};
