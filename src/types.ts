export type LoopLanguage = "zh-Hant" | "en";

export type Question = {
  qid: string;
  sourceId: string;
  name: string;
  text: string;
  lang: "zh" | "en" | "other";
  upvotes: number;
  lens: string;
  dupGroup: string;
};

export type Beat = {
  beatId: string;
  order: number;
  title: string;
  ache: string;
  theTurn: string;
  memberQids: string[];
  representativeQid: string;
  bridgeToNext: string;
};

export type Bridge = { tension: string; beatIds: string[]; qids: string[]; resolution: string };

export type Take = { beatId: string; take: string; grounded: boolean; citations: string[] };

export type Role = "crystalliser" | "chorus" | "bridge" | "keeper";

export type Loopback = { qid: string; beatId: string; role: Role; reply: string };

export type LoopStatus = "queued" | "clustering" | "arcing" | "forging" | "replying" | "ready" | "waiting-budget" | "failed" | "deleted";

export type Progress = {
  status: LoopStatus;
  step: string;
  done: number;
  total: number;
  attempts: number;
  lastError: string;
  nextAttemptAt: number | null;
  neuronsReserved: number;
};

export type Verification = {
  pool: number;
  replies: number;
  coverage: boolean;
  empty: string[];
  cloneGroups: number;
  ungroundedTakes: number;
  beatsCoverAllQids: boolean;
};

export type Receipt = {
  throughline: string;
  opening: string;
  closing: string;
  beats: Beat[];
  bridges: Bridge[];
  takes: Take[];
  loopbacks: Loopback[];
  questions: Question[];
  verification: Verification;
  generatedAt: number;
};

export type PublicLoop = {
  loopId: string;
  title: string;
  speaker: string;
  standfirst: string;
  language: LoopLanguage;
  createdAt: number;
  updatedAt: number;
  questions: number;
  progress: Progress;
  model: string;
  receipt: Receipt | null;
};
