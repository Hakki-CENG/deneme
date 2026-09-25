import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CognitiveWorkspaceService } from "../src/cognitive/cognitive-workspace-service.js";

describe("Aurora Global Workspace and cognitive control", () => {
  it("arbitrates constitutional goal classes before local numeric scores", async () => {
    const root=await mkdtemp(join(tmpdir(),"haf-cognitive-goals-"));const service=new CognitiveWorkspaceService(root);
    const project=await service.createGoal({tenantId:"tenant",title:"Project optimization",objective:"Improve throughput",class:"P3",importance:1,urgency:1,userRelevance:1});
    const safety=await service.createGoal({tenantId:"tenant",title:"User safety",objective:"Prevent destructive action",class:"P1",importance:.4,urgency:.4,userRelevance:.8});
    const result=await service.arbitrateGoals("tenant");
    expect(result.winnerGoalId).toBe(safety.id);expect(result.rankedGoalIds[0]).toBe(safety.id);expect(result.rankedGoalIds).toContain(project.id);
  });

  it("allocates attention by goal class and score under token/slot budgets", async () => {
    const root=await mkdtemp(join(tmpdir(),"haf-cognitive-attention-"));const service=new CognitiveWorkspaceService(root);
    await service.configureBudget("tenant",15000,2);
    const p1=await service.createGoal({tenantId:"tenant",title:"Safety",objective:"Safety",class:"P1",importance:.8,urgency:.8,userRelevance:1});
    const p3=await service.createGoal({tenantId:"tenant",title:"Research",objective:"Research",class:"P3",importance:1,urgency:1,userRelevance:1});
    const safety=await service.createObject({tenantId:"tenant",kind:"risk",title:"Data loss",content:"Backup is missing",sourceType:"event",confidence:.9,importance:.9,urgency:.9,impact:1,userRelevance:1,horizon:"reactive",goalId:p1.id,requestedTokens:8000});
    const research=await service.createObject({tenantId:"tenant",kind:"opportunity",title:"Paper",content:"New paper",sourceType:"event",confidence:1,importance:1,urgency:1,impact:1,userRelevance:1,horizon:"strategic",goalId:p3.id,requestedTokens:7000});
    await service.createObject({tenantId:"tenant",kind:"observation",title:"Low",content:"Low value",sourceType:"system",confidence:.2,importance:.2,urgency:.2,impact:.2,userRelevance:.2,horizon:"tactical",requestedTokens:1000});
    const allocation=await service.allocateAttention("tenant");
    expect(allocation.focused.map(x=>x.id)).toEqual([safety.id,research.id]);expect(allocation.budget.reservedTokens).toBe(15000);expect(allocation.deferred).toHaveLength(1);
    await service.completeFocus("tenant",safety.id,"solved",6000);
    expect(await service.budget("tenant")).toMatchObject({usedTokens:6000,reservedTokens:7000});
  });

  it("detects repeated thought-loop outcomes by hash and blocks without storing raw iterations", async () => {
    const root=await mkdtemp(join(tmpdir(),"haf-cognitive-loop-"));const service=new CognitiveWorkspaceService(root);
    const object=await service.createObject({tenantId:"tenant",kind:"problem",title:"Repeated problem",content:"Find another approach",sourceType:"agent",confidence:.5,importance:.8,urgency:.5,impact:.7,userRelevance:.8,horizon:"tactical"});
    expect((await service.recordIteration("tenant",object.id,"same result")).loopDetected).toBe(false);
    expect((await service.recordIteration("tenant",object.id,"same result")).repeatCount).toBe(2);
    const third=await service.recordIteration("tenant",object.id,"same result");expect(third.loopDetected).toBe(true);expect(third.object.state).toBe("blocked");
    const disk=await readFile(join(root,"cognitive","workspace.json"),"utf8");expect(disk).not.toContain("same result");expect(disk).toContain(createHashForTest("same result"));
  });

  it("enforces cognitive mode transitions and rolls daily attention reservations safely", async () => {
    let now=Date.parse("2026-08-19T12:00:00Z");const root=await mkdtemp(join(tmpdir(),"haf-cognitive-mode-"));const service=new CognitiveWorkspaceService(root,()=>now);
    expect((await service.mode("tenant")).mode).toBe("reactive");
    expect((await service.transitionMode("tenant","research","Investigate evidence")).mode).toBe("research");
    expect((await service.transitionMode("tenant","dream","Low-priority synthesis")).mode).toBe("dream");
    await expect(service.transitionMode("tenant","development","Forbidden direct jump")).rejects.toThrow("forbidden");
    await service.configureBudget("tenant",10000,1);await service.createObject({tenantId:"tenant",kind:"insight",title:"Focus",content:"focus",sourceType:"system",confidence:1,importance:1,urgency:1,impact:1,userRelevance:1,horizon:"tactical",requestedTokens:5000});await service.allocateAttention("tenant");expect((await service.budget("tenant")).reservedTokens).toBe(5000);
    now+=24*60*60*1000;const rolled=await service.budget("tenant");expect(rolled).toMatchObject({usedTokens:0,reservedTokens:0});expect((await service.objects("tenant"))[0]!.attentionState).toBe("queued");
  });
});
function createHashForTest(value:string){return createHash("sha256").update(value).digest("hex");}
