import { defineDeployedSelfModificationSandbox } from "../../../deployed/checkout.js";
import selfModification from "../../extension.js";

export default defineDeployedSelfModificationSandbox(selfModification.config);
