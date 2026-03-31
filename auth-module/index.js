import authRoutes from "./src/routes/auth.routes.js";
import { createUserModel } from "./src/models/User.js";
import { protect } from "./src/middlewares/auth.middleware.js";

let User;

export const initAuth = ({ app, db, options = {} }) => {
  if (!app) throw new Error("Express app instance is required");
  if (!db) throw new Error("Database instance is required");

  // 🔑 bind model to backend mongoose
  User = createUserModel(db);

  const prefix = options.routePrefix || "/api/auth";
  app.use(prefix, authRoutes);
};

export { protect };
export { User };
