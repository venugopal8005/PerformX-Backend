import authRoutes from "./src/routes/auth.routes.js";
import { createAgencyModel } from "./src/models/Agency.js";
import { createUserModel } from "./src/models/User.js";
import { protect } from "./src/middlewares/auth.middleware.js";
import { generateToken } from "./src/services/token.service.js";
import { cookieOptions } from "./src/config/cookieOptions.js";

let Agency;
let User;
let authDb;
let externalModels = {};

export const initAuth = ({ app, db, options = {} }) => {
  if (!app) throw new Error("Express app instance is required");
  if (!db) throw new Error("Database instance is required");

  authDb = db;
  externalModels = options.models || {};
  Agency = createAgencyModel(db);
  User = createUserModel(db);

  const prefix = options.routePrefix || "/api/auth";
  app.use(prefix, authRoutes);
};

export const getAuthModel = (modelName) =>
  externalModels?.[modelName] || authDb?.models?.[modelName] || null;

export { protect };
export { generateToken };
export { cookieOptions };
export { Agency };
export { User };
