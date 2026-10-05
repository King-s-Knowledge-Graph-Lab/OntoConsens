import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import projectsRouter from "./projects";
import propertiesRouter from "./properties";
import moderatorRouter from "./moderator";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(projectsRouter);
router.use(propertiesRouter);
router.use(moderatorRouter);

export default router;
