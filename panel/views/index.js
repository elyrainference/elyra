// View registry: id -> { enter(), tick?() }. enter() renders the view's shell once; tick() (optional) refreshes only its dynamic regions every 3 s.
import { connect } from "./connect.js";
import { models } from "./models.js";
import { network } from "./network.js";
import { live } from "./live.js";
import { overview } from "./overview.js";
import { payments } from "./payments.js";
import { playground } from "./playground.js";
import { provide } from "./provide.js";
import { routing } from "./routing.js";

export const views = { overview, live, playground, models, routing, network, payments, provide, connect };
