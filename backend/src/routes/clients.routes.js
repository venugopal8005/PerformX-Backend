import { Router } from "express";
import { protect } from "auth-module";
import {
  createClient,
  deleteClient,
  getClient,
  getClients,
  updateClient,
} from "../controllers/clients.controller.js";

const clientRouter = Router();

clientRouter.post("/", protect, createClient);
clientRouter.get("/", protect, getClients);
clientRouter.get("/:clientId", protect, getClient);
clientRouter.patch("/:clientId", protect, updateClient);
clientRouter.delete("/:clientId", protect, deleteClient);

export default clientRouter;
