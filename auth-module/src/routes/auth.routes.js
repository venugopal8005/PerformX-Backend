import { Router } from "express";
import { login } from "../controllers/auth.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { me } from "../controllers/auth.controller.js";
import { logout } from "../controllers/auth.controller.js";
import { refresh } from "../controllers/auth.controller.js";
import { register } from "../controllers/auth.controller.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", protect, me);
router.post("/logout", logout);
router.post("/refresh", refresh);

export default router;
