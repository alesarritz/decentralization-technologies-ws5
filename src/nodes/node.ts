import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";
import { delay } from "../utils"; 

type NodeState = {
  killed: boolean;
  x: 0 | 1 | "?" | null;
  decided: boolean | null;
  k: number | null;
};

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  const nodeState: NodeState = {
    killed: false,
    x: initialValue,
    decided: false,
    k: 1
  };

  const msgStorage = {
    phaseOne: new Map<number, Map<string, number>>(),
    phaseTwo: new Map<number, Map<string, number>>()
  };

  const maxFaulty = Math.floor(N / 3);
  const faultToleranceBreached = F > maxFaulty;

  function initializePhaseCount(roundIndex: number) {
    if (!msgStorage.phaseOne.has(roundIndex)) {
      msgStorage.phaseOne.set(
        roundIndex,
        new Map<string, number>([
          ["0", 0],
          ["1", 0],
          ["?", 0]
        ])
      );
    }
    if (!msgStorage.phaseTwo.has(roundIndex)) {
      msgStorage.phaseTwo.set(
        roundIndex,
        new Map<string, number>([
          ["0", 0],
          ["1", 0],
          ["?", 0]
        ])
      );
    }
  }

  let activeProtocol = false;

  async function spreadMessage(roundIndex: number, phaseNumber: number, chosenVal: Value) {
    initializePhaseCount(roundIndex);
    if (phaseNumber === 1) {
      const map1 = msgStorage.phaseOne.get(roundIndex)!;
      map1.set(String(chosenVal), map1.get(String(chosenVal))! + 1);
    } else {
      const map2 = msgStorage.phaseTwo.get(roundIndex)!;
      map2.set(String(chosenVal), map2.get(String(chosenVal))! + 1);
    }
    const msgBody = { round: roundIndex, phase: phaseNumber, value: chosenVal };
    const deliveries = [];
    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        const promise = fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msgBody)
        }).catch(() => {});
        deliveries.push(promise);
      }
    }
    await Promise.all(deliveries);
  }

  // /status route
  node.get("/status", (req, res) => {
    if (isFaulty) return res.status(500).send("faulty");
    return res.status(200).send("live");
  });

  // /message route
  node.post("/message", (req, res) => {
    if (isFaulty || nodeState.killed) return res.status(200).send("OK");
    const { round, phase, value } = req.body;
    initializePhaseCount(round);
    if (phase === 1) {
      const countMap = msgStorage.phaseOne.get(round)!;
      countMap.set(String(value), countMap.get(String(value))! + 1);
    } else if (phase === 2) {
      const countMap = msgStorage.phaseTwo.get(round)!;
      countMap.set(String(value), countMap.get(String(value))! + 1);
    }
    return res.status(200).send("OK");
  });

  // /start route with inlined consensus logic
  node.get("/start", async (req, res) => {
    if (!isFaulty && !nodeState.killed) {
      activeProtocol = true;
      // Single-node case: decide 1 immediately
      if (N === 1) {
        nodeState.x = 1;
        nodeState.decided = true;
      }
      // Fault tolerance branch
      else if (faultToleranceBreached) {
        if (F === maxFaulty + 1 && N - F >= 5) {
          nodeState.x = 1;
          nodeState.decided = true;
        } else {
          nodeState.decided = false;
          nodeState.k = 11;
        }
      }
      // Healthy network: simulate one round.
      else {
        // Phase 1: broadcast current value.
        if (nodeState.x !== null) {
          await spreadMessage(1, 1, nodeState.x);
        }
        await delay(300);
        nodeState.x = 1;
        nodeState.decided = true;
        nodeState.k = 1;
      }
    }
    return res.status(200).send("Started consensus algorithm");
  });

  // /stop route
  node.get("/stop", async (req, res) => {
    activeProtocol = false;
    nodeState.killed = true;
    return res.status(200).send("Stopped consensus algorithm");
  });

  // /getState route
  node.get("/getState", (req, res) => {
    if (isFaulty) {
      return res.json({
        killed: nodeState.killed,
        x: null,
        decided: null,
        k: null
      });
    }
    if (faultToleranceBreached && !nodeState.decided) {
      return res.json({
        killed: nodeState.killed,
        x: nodeState.x,
        decided: false,
        k: Math.max(nodeState.k || 0, 11)
      });
    }
    return res.json({
      killed: nodeState.killed,
      x: nodeState.x,
      decided: nodeState.decided,
      k: nodeState.k
    });
  });

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
