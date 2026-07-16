import { Router } from "express";
import { protect } from "auth-module";
import {
  createClient,
  deleteClient,
  getArchivedClients,
  getClient,
  getClientHistory,
  getClients,
  updateClient,
} from "../controllers/clients.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const clientRouter = Router();

clientRouter.post("/", protect, requireWorkspaceMember, createClient);
clientRouter.get("/", protect, requireWorkspaceMember, getClients);
clientRouter.get("/archived", protect, requireWorkspaceMember, getArchivedClients);
clientRouter.get("/:clientId/history", protect, requireWorkspaceMember, getClientHistory);
clientRouter.get("/:clientId", protect, requireWorkspaceMember, getClient);
clientRouter.patch("/:clientId", protect, requireWorkspaceMember, updateClient);
clientRouter.delete("/:clientId", protect, requireWorkspaceMember, deleteClient);

export default clientRouter;
