import { Router } from "express";
import {
  googleSignup,
  login,
  logout,
  me,
  refresh,
  register,
} from "../controllers/auth.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/google", googleSignup);
router.get("/me", protect, me);
router.post("/logout", logout);
router.post("/refresh", refresh);

export default router;
