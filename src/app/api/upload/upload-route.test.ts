// Node's test runner treats brackets in an explicit test path as a glob.
// Keep the route-local tests beside the implementation and load them through
// this discoverable filename so the full unit suite actually executes them.
import "./[...path]/route.test";
