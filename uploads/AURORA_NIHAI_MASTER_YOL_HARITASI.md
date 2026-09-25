# Aurora Motor Engine — Nihai Master Yol Haritası

Tarih: 2026-09-23
Kapsam: Son kullanıcı ZIP'i + son sistem taramaları + Aurora Agent Society Architecture V1

## Bu belgenin amacı

Bu liste, Aurora'nın kullanıcının tarif ettiği nihai hedefe — Jarvis benzeri, genel amaçlı, uzun ömürlü, proaktif, araç kullanabilen, planlayabilen, öğrenebilen, kendini kontrollü biçimde geliştirebilen kişisel dijital yardımcı/agent runtime — ulaşması için gereken işleri tek bir backlog altında toplar.

Buradaki “tamamlandı” tanımı dosya sayısı veya servis sayısı değildir. Her özellik gerçek runtime davranışı, doğrulama, geri besleme, güvenlik ve gerçek dünya entegrasyonu ile çalışmalıdır.

PDF'deki nihai vizyonla uyumlu hedef döngü:

Observe → Understand → Think → Plan → Act → Learn → Remember → Reflect → Evolve → Observe

## Mevcut durumun özeti

Son ZIP'te yaklaşık 1477 dosya, 635 code-like dosya, ~145.7k satır ve 217 test dosyası bulunuyor. 10 workspace mevcut. Proje kendi son raporlarında 1495 testin geçtiğini, typecheck'in temiz olduğunu ve integration kontrollerinin yeşil olduğunu raporluyor; bunlar bu belgede proje tarafından üretilmiş doğrulama sonuçları olarak kabul edilir, bu oturumda tüm test suite'i yeniden çalıştırılmış bir bağımsız sonuç olarak değil.

Şu anki mimari zaten şu büyük yapıtaşlarına sahip:
- durable runtime / session actor / supervisor / journals / snapshots
- Unified Execution Loop
- ModelSelectionEngine
- ModelRouter / ModelConfigurationRegistry / ModelCapabilityRegistry
- CapabilityBroker / security / policy / approvals / sandbox
- real filesystem / browser / Git / MCP / process capability'leri
- verification / recovery / failure taxonomy
- memory graph / long horizon memory / retrieval pipeline
- thought / background thinking / reflection altyapısı
- world model / prediction / causal / counterfactual altyapısı
- agent society / delegation / reputation / marketplace / council
- goal discovery / initiative / user model
- learning / skill synthesis / capability acquisition / self-improvement altyapısı
- API / Canvas / desktop / release / eval / CI

Ana problem artık “temel mimari yok” değil. Ana problem, bu parçaların her birinin alanında derinleşmesi ve tümünün tek bir kapalı, güvenilir, ölçülebilir, uzun ömürlü otonom çalışma döngüsüne bağlanmasıdır.

---

# P0 — Doğrudan doğruluk, güvenlik ve mimari bütünlük

## P0.1 Model routing'i tek otorite haline getir
- Unified Execution Loop → ModelSelectionEngine → gerçek route zincirini tek public giriş noktası yap.
- `routing/model-routing.ts`'yi ikinci bir selector olmaktan çıkar.
- Onu task requirements, benchmark/history, offline analysis katmanı olarak ya tut ya da sonunda temizle.
- Sırf maturity sayısını 30/30 yapmak için idle modülü yapay olarak çalıştırma.
- `ModelSelectionEngine` kararının gerçekten `SessionActor` / provider çağrısında uygulandığını koru.

## P0.2 Model aday kümesini tamamen gerçek kaynaklardan oluştur
- Provider registry'den gerçek provider'ları al.
- ModelConfigurationRegistry'den gerçek provider:model kayıtlarını al.
- Enabled/disabled ve authorization durumunu hesaba kat.
- Provider default model fallback'ini açıkça tanımla.
- Geçersiz veya bulunmayan route'u çalıştırma.

## P0.3 Ölçülmemiş model metriği hatasını düzelt
- `latency=0`, `cost=0` veya `reliability=default` gibi sentetik neutral değerlerin scorer'ı yanlış yönlendirmesine izin verme.
- “unmeasured” ile “measured zero” ayrımını tip seviyesinde yap.
- AdaptiveRouter scorer'ları `undefined/unmeasured` durumunu açıkça ele alsın.
- İlk kullanımda modelin gerçek ölçümü yoksa exploration/cold-start politikası uygula.
- Sahte accuracy/latency/cost üretme.

## P0.4 Model seçim outcome feedback'ini canlı execution'a bağla
- Her gerçek model çağrısından sonra provider/model ID, latency, input/output token, cost (varsa), success/failure, retry, timeout, tool-call success, final verification outcome toplanmalı.
- Bu sonuçlar `AdaptiveRouter.recordOutcome()`'a gitmeli.
- `ModelCapabilityRegistry.recordOutcome()`'a gitmeli.
- Task-level outcome ile model-level outcome ayrılmalı.
- Kullanıcı/API'nin elle outcome göndermesine bağımlı kalmamalı.
- Sonraki selection aynı runtime oturumunda bile yeni ölçümü kullanabilmeli.

## P0.5 Shared CognitiveState'i task-local hale getir
- `PlanningEngine` içindeki global `activePlan/activeGoal` state'ini task/session/tenant scope'una taşı.
- Paralel görevlerin birbirinin planını ezmesini engelle.
- Snapshot/recovery sırasında task cognitive state'ini restore et.
- Tenant isolation testi ekle.

## P0.6 Recovery stratejilerini semantik hale getir
- `replan` gerçekten yeni plan üretmeli.
- `reduce_scope` gerçekten scope'u değiştirmeli.
- `change_tool`, `change_model`, retry mevcut gerçek davranışı koruyup evidence üretmeli.
- Recovery directive ile gerçek action arasında birebir bağlantı kur.
- Retry döngüsünün budget/deadline/attempt limitleri olsun.
- Aynı effect'in iki kez uygulanmasını idempotency anahtarı ile kontrol et.

## P0.7 Security failure'da fail-closed davranış
- Security screening hook throw ettiğinde kritik action'ı otomatik devam ettirme.
- “security unavailable” = güvenli olmayan action'ı bloke et.
- Prompt-injection screening unavailable durumunu ayrı status ile göster.
- Kullanıcıya gerekli ise yeniden onay iste.

## P0.8 Gerçek cryptographic extension signing
- `AgentSDKService.signExtension()` için UUID benzeri sahte signature kaldır.
- Gerçek key pair / detached signature / verification kullan.
- Key rotation, trust root, revocation ve signature policy ekle.
- Signed artifact ile source hash bağını kur.

## P0.9 Var olan kaynak bulunamadığında typed errors
- Session/entity/automation/learning/refinement/agent profile gibi get'lerde `NotFoundError` kullan.
- Control API doğru `404` döndürsün.
- 500 yalnız gerçek internal/server arızası için kullanılsın.
- Error code standardı tüm API'ye yay.

## P0.10 Maturity ölçümünü gerçeğe tam bağla
- `integrated/exercised/verified/production` düzeylerinin algoritmasını düzelt.
- Stale comments ve stale prose temizle.
- “constructed at startup” ile “did useful work” ayrımını koru.
- Başarısız bir capability çağrısını “exercised successfully” sayma.
- Ölçüm tool'u kendi kendini test etsin.

## P0.11 Tek source-of-truth durum dokümanları
- `CURRENT_STATE.md`, `MATURITY_MATRIX.md`, `KNOWN_GAPS.md` authoritative olsun.
- Elle yazılmış eski MD'leri arşiv veya redirect yap.
- “production-ready”, “%85 complete”, eski test sayıları gibi ölçülemez/eski iddiaları authoritative dokümandan çıkar.
- Her sayısal iddia komut/rapor kaynağına bağlansın.

---

# P1 — Gerçek Jarvis çekirdeği: görev çözme

## P1.1 Tek bir universal task primitive
- Chat, API, scheduler, proactive initiative, channel, MCP ve background task girişlerinin hepsini ortak task lifecycle'a bağla.
- Gerekirse farklı frontend surface'leri aynı `TaskContext`/execution primitive'e dönüştürsün.
- Her görevin ID, tenant, user, parent task, deadline, budget, priority ve provenance bilgisi olsun.

## P1.2 Gerçek task understanding
- LLM/model-backed intent and goal understanding ekle.
- Kullanıcı hedefi, constraints, preferences, deadline, expected artifact ve success criteria çıkar.
- Eksik bilgi kritikse clarifying question üret.
- Belirsizlik yüksekse hemen action yapmak yerine ask/think/research kararı ver.

## P1.3 Task-specific planner
- Keyword skeleton planner'dan model-backed veya hybrid planner'a geç.
- Goal decomposition.
- Dependency graph / DAG.
- Parallelizable steps.
- Resource constraints.
- Preconditions/postconditions.
- Expected outputs.
- Verifiers per step.
- Cost/time budget.
- Risk score.

## P1.4 Gerçek plan execution
- Plan adımlarını yalnız prompt'a koyma; runtime bunları gerçekten yürütmeli.
- Step status: queued/running/blocked/succeeded/failed/retrying/verified/unverified.
- Step başına evidence.
- Step-level tool/agent attribution.
- Partial completion.
- Resume after crash.

## P1.5 Dynamic replanning
- World change, tool failure, new information veya user interruption sonrası planı yeniden hesapla.
- Completed steps korunmalı.
- Etkilenen subtree yeniden planlanmalı.
- Gereksiz işleri tekrar etme.

## P1.6 Plan-aware verification
- Her plan step'i için success criterion oluştur.
- Build/test gibi genel kanıtı goal-specific verification'dan ayır.
- Verifier seçimini otomatikleştir.
- V3 consensus için evaluator panelini otomatik oluştur.

## P1.7 Evidence-first completion
- “Agent says done” tek başına success olmasın.
- Gerçek artifact, test, diff, command output, browser result, API result, file hash vb. evidence gereksinimlerini tanımla.
- Kullanıcıya neyin doğrulandığını göster.

## P1.8 Long-horizon task manager
- Saatler/günler süren görevlerde durable queue.
- Pause/resume.
- Scheduled continuation.
- Deadline awareness.
- Human approval waiting state.
- Failure escalation.
- Parent-child tasks.
- Progress digest.

---

# P1 — Reasoning ve cognition derinliği

## P1.9 Reasoning Engine'i gerçek decision path'e bağla
- Multi-hypothesis reasoning görev başında gerektiğinde otomatik devreye girsin.
- Hypothesis lifecycle: proposed/tested/supported/rejected/uncertain/confirmed.
- Evidence object'leriyle bağ kur.
- Critic gerçekten karar üzerinde etkili olsun.

## P1.10 Belirsizlik motorunu gerçek karar etkisine bağla
- Confidence ile probability ayrımını netleştir.
- Calibration ölç.
- Düşük güven → research/verification/escalation.
- Yüksek risk + düşük confidence → human approval.

## P1.11 Counterfactual reasoning
- “A yerine B yapsaydım?” senaryosu üret.
- Gerçek karar öncesi gerektiğinde alternative branches hesapla.
- Sonuçları uncertainty ve risk ile ilişkilendir.

## P1.12 Attention / cognitive budget
- Token, latency, cost, CPU/GPU, concurrent agent ve human attention bütçelerini ortak bir attention allocator ile yönet.
- “think more vs act now vs ask user” kararı üret.
- Düşük değerli düşünceleri kes.

## P1.13 Cognitive modes gerçek çalışsın
- Reactive
- Research
- Development
- Reflection
- Dream
- Emergency
- Her mode için entry/exit condition ve resource budget.

## P1.14 Global Workspace
- Önemli observations, hypotheses, plans, risks, goals ve events için ortak cognitive blackboard oluştur.
- Salience / attention scoring ile seç.
- Tüm ajanların tüm state'i görmesi yerine relevant context federation kullan.

---

# P1 — Memory: gerçekten öğrenen hafıza

## P1.15 Gerçek semantic embeddings'i runtime'a taşı
- Eval'de kullanılan gerçek encoder benchmark'ı production retrieval'e bağla.
- Hash embedding'i default semantic path olmaktan çıkar.
- Model/provider bağımsız embedding abstraction kur.
- Local + external embedding backend desteği.

## P1.16 Durable vector/index backend
- Vector index + graph + metadata store birlikte çalışsın.
- Index rebuild ve compaction.
- Tenant isolation.
- Versioned embeddings.
- Embedding model migration.

## P1.17 Retrieval pipeline'ı source-of-truth yap
- BM25 + vector + RRF + rerank üretim path'inde standart pipeline olsun.
- Benchmark ve production aynı pipeline'a dayanmalı.
- Recall@k, MRR, nDCG, latency ve hit attribution ölç.

## P1.18 Memory semantics
- Observation ≠ inference ≠ hypothesis ≠ prediction ayrımı korunmalı.
- Source, provenance, confidence, importance, validity, superseded state.
- User correction/retraction.
- Contradiction management.

## P1.19 Memory consolidation
- Episodic → semantic/procedural promotion.
- Redundancy compression.
- Temporal clustering.
- Importance decay.
- Goal-conditioned retention.
- User-controlled protected memories.

## P1.20 Procedural memory / skills
- Başarılı task trajectory'den reusable procedure çıkar.
- Actual tool sequence + conditions + verification kriterlerini sakla.
- Skill replay testleri oluştur.

## P1.21 Memory isolation / safety
- Retrieved memory'deki `[tool]` benzeri direktiflerin prompt injection etkisini engelle.
- Memory source trust level taşısın.
- Untrusted content never executable by itself.

---

# P1 — World Model

## P1.22 World state engine
- Entity/state/relation/event/outcome tek modelde.
- Temporal versioning.
- Confidence ve source.
- User/project/environment/digital world ayrımları.

## P1.23 Learned prediction
- Prediction'ı caller-provided heuristic olmaktan çıkar.
- Model gerçek geçmiş outcome'larla eğitilsin.
- Prediction error ölçülüp model güncellensin.
- Calibration curves.

## P1.24 Reality alignment
- World model iddiaları gerçek tool observations ile periyodik karşılaştırılsın.
- Out-of-date state tespit edilsin.
- Source freshness ve confidence decay.

## P1.25 Multi-world reasoning
- Technical
- Economic
- Risk
- Opportunity
- Human
- Strategic
- Security
- Scientific
- Creativity
- User-centric
- Time
- Complexity perspektifleri.
- Perspektifler arası conflict/debate/consensus.

## P1.26 Future tree / scenario planner
- Branching futures.
- Probability estimate + confidence.
- Cost/risk/benefit.
- User goal alignment.

---

# P1 — Agent Society

## P1.27 Gerçek specialist delegation
- Görev karmaşıklığına göre otomatik specialist agent oluştur/seç.
- Research/Coding/Security/Planning/Memory/World/User/Reflection vb.
- Specialist sonucu parent task'a actual evidence olarak bağlanmalı.

## P1.28 Agent lifecycle
- spawn
- assign
- observe
- message
- pause
- resume
- cancel
- wait
- join
- aggregate
- verify
- retry
- reassign
- escalate
- retire

## P1.29 Dynamic composition
- Göreve göre geçici team oluştur.
- Gereksiz agent yaratma.
- Agent budget ve context budget.
- Cyclic delegation detection.

## P1.30 Society governance
- Reputation evidence-based olsun.
- Reputation decay.
- Skill specialization.
- Conflict resolution.
- Dissent and second opinion.
- Council quorum.
- Critical actions için stronger consensus.

## P1.31 Society execution economy
- Token/time/cost bütçeleri.
- Agent-level accounting.
- Cost-benefit.
- Budget exhaustion recovery.

## P1.32 Agent communication güvenliği
- Mesaj provenance.
- Trust levels.
- Injection detection.
- Cross-family isolation.
- Least privilege.

---

# P1 — Embodiment: Aurora'nın elleri

## P1.33 Generic tool abstraction
- Her capability için common contract.
- input schema
- output schema
- side effect classification
- permission
- risk
- idempotency
- verifier
- rollback

## P1.34 Filesystem production hardening
- workspace confinement.
- symlink race defense.
- quotas.
- file locking.
- binary-safe operations.
- large file streaming.
- archive safety.

## P1.35 Terminal / process control
- secure command execution.
- environment isolation.
- timeouts.
- stdout/stderr capture.
- resource quotas.
- process tree kill.
- artifact collection.

## P1.36 Browser/computer-use actuator
- mouse/keyboard/click/type/scroll/select/file upload.
- visual observation.
- DOM + accessibility tree.
- action verification.
- anti-loop.
- human confirmation for sensitive actions.

## P1.37 Git/GitHub deep integration
- clone
- branch
- diff
- commit
- push
- PR creation
- PR review
- CI status
- merge policy
- rollback.

## P1.38 Code intelligence
- symbol graph.
- definitions/references.
- language server.
- dependency graph.
- build/test orchestration.
- refactor verification.
- patch generation.

## P1.39 Environment mapper
- installed software.
- available interpreters.
- tool versions.
- project structure.
- network state.
- device state.
- permissions.

---

# P1 — Research / web / knowledge

## P1.40 Real research backend
- Search providers.
- Browser collection.
- Source extraction.
- PDF/paper parsing.
- HTML cleanup.
- Deduplication.
- source freshness.

## P1.41 Citation/provenance
- Every factual research claim source-bound.
- Source trust metadata.
- Claim → quote/span → source relation.
- Citation preservation in memory.

## P1.42 Research Director gerçek workflow
- question
- search
- collect
- compare
- verify
- synthesize
- cite
- report
- remember.

## P1.43 Research watcher
- Follow topics, projects, repositories, papers, technologies.
- Change detection.
- Importance scoring.
- User attention budget.

---

# P1 — User Model ve kişisel asistan

PDF hedefindeki user model davranış/goal/habit/context odaklı olmalı; hassas kimlik/sağlık vb. çıkarımlar yapılmamalı.

## P1.44 User model event wiring
- Conversation → goals/preferences only when consented.
- Task outcomes → advice effectiveness.
- Projects → expertise/context.
- Corrections → retraction/update.

## P1.45 Goal model
- short/medium/long-term goals.
- dependencies.
- progress.
- priority.
- conflicts.

## P1.46 Project model
- GitHub/repo/workspace links.
- active tasks.
- deadlines.
- architecture understanding.
- recent failures.
- next actions.

## P1.47 Advice effectiveness
- Recommendation issued.
- User outcome observed.
- Effectiveness score.
- Context-sensitive adjustment.

## P1.48 User controls
- view memory.
- edit/delete memory.
- export.
- correction.
- consent controls.
- per-feature privacy.
- retention periods.

---

# P1 — Proactive Aurora

## P1.49 Event intake bus
Events from:
- memory
- world
- GitHub
- calendar
- files
- research
- environment
- notifications
- tasks
- schedules.

## P1.50 Initiative engine
- opportunity detection.
- risk detection.
- goal alignment.
- context fit.
- value estimate.
- attention cost.
- notification worthiness.

## P1.51 Durable proactive scheduler
- watcher state persistent.
- cooldown persistent.
- deduplication.
- event offsets.
- restart-safe scheduling.

## P1.52 Communication selector
- in-app.
- desktop.
- email.
- Discord.
- Telegram.
- mobile notification.
- future voice.
- channel preference + quiet hours + importance.

## P1.53 Daily/weekly/monthly briefings
- daily status.
- weekly review.
- monthly strategic review.
- project risk summary.
- new opportunity summary.
- memory/goal changes.

## P1.54 Trust-preserving initiative policy
- silence when low value.
- never spam.
- user override.
- emergency escalation.
- explain why an intervention occurred.

---

# P2 — Learning ve self-improvement

## P2.1 Outcome learning
- Task outcome → strategy update.
- Tool success rates.
- Agent success rates.
- Model performance.
- Plan pattern performance.

## P2.2 Skill discovery
- trajectory mining.
- procedural abstraction.
- reusable skill schema.
- preconditions/postconditions.

## P2.3 Skill testing
- regression corpus.
- known-good.
- known-bad.
- adversarial.
- held-out tasks.
- side-effect safety.

## P2.4 Skill promotion/retirement
- evidence threshold.
- versioning.
- rollback.
- canary deployment.
- usage tracking.
- automatic retirement of harmful/obsolete skills.

## P2.5 Capability acquisition
- generic contract synthesis.
- code generation.
- dependency handling.
- sandbox.
- static analysis.
- runtime tests.
- adversarial tests.
- broker publication.
- original-task retry.
- broaden beyond current narrow requirement set.

## P2.6 Self-improvement semantic evaluation
- Behavioral benchmark.
- not just syntax/AST checks.
- task score before/after.
- no regression on protected suites.
- performance/cost impact.

## P2.7 Self-debugging
- reproduce failure.
- isolate component.
- causal hypothesis.
- patch candidate.
- test.
- benchmark.
- promote/rollback.

## P2.8 Self-model
- strengths/weaknesses.
- reliability per capability.
- uncertainty.
- known limitations.
- current workload.
- available tools/models.

## P2.9 Meta-learning
- learn how to choose strategies.
- learn when to ask user.
- learn when to delegate.
- learn when to research.
- learn when to verify.

---

# P2 — Thought / Reflection / Dream

## P2.10 Background thinking scheduler
- real durable queue.
- resource budget.
- sleep/wake lifecycle.
- interruption policy.

## P2.11 Curiosity manager
- unanswered user/project/world questions.
- priority by value and urgency.

## P2.12 Open problem tracker
- persistent problem IDs.
- linked hypotheses.
- research attempts.
- next experiment.
- resolution status.

## P2.13 Thought anchors
- long-lived ideas.
- concepts.
- projects.
- unresolved questions.
- scheduled re-evaluation.

## P2.14 Reflection cycles
- after significant tasks.
- after failure.
- after milestone.
- periodic reflection.

## P2.15 Dream mode
- low-risk offline concept recombination.
- no external side effects.
- strict resource budget.
- output promoted only with verification.

---

# P2 — Digital Twin / environment

## P2.16 User digital twin
- behavioral/goal/habit model only.
- not identity impersonation.
- opt-in.
- predictive evaluation.

## P2.17 Project digital twin
- repository graph.
- architecture.
- dependency health.
- backlog.
- recent activity.
- risk.

## P2.18 Environment digital twin
- device.
- available software.
- schedules.
- network.
- workspace state.

## P2.19 Twin prediction loop
- predict.
- act.
- observe.
- compare.
- update.

---

# P2 — Multimodal / voice

## P2.20 Real STT
- local and remote backend abstraction.
- streaming.
- language detection.
- interruption/barge-in.

## P2.21 Real TTS
- streaming.
- voice profiles.
- interruption.
- latency measurement.

## P2.22 Vision
- image understanding.
- screenshot analysis.
- OCR fallback.
- video frames.
- visual state tracking.

## P2.23 Multimodal context
- image/audio/video references in memory.
- provenance.
- modality-specific confidence.

---

# P2 — Connectors / channels

## P2.24 First-class connector SDK
Generic contract for:
- Gmail
- Outlook
- Calendar
- Drive
- Notion
- Discord
- Telegram
- Slack
- GitHub
- Jira/Linear-style issue trackers
- CRM/ERP where configured
- IoT/home APIs.

## P2.25 Connector safety
- OAuth.
- least privilege scopes.
- token rotation.
- per-action approval.
- audit.
- revocation.

## P2.26 Connector reliability
- retries.
- dedupe.
- rate limits.
- pagination.
- webhook verification.
- backoff.

---

# P2 — Agent SDK / plugins

## P2.27 Secure agent sandbox
- real Worker/WASI/container isolate.
- resource quotas.
- permissions.
- network policy.
- filesystem policy.

## P2.28 Extension lifecycle
- install.
- inspect.
- sign.
- verify.
- enable.
- disable.
- upgrade.
- rollback.
- revoke.

## P2.29 Capability marketplace
- discover.
- reputation.
- compatibility.
- trust.
- versioning.
- sandbox validation.

---

# P2 — Federated / distributed edge

## P2.30 Real node federation
- desktop/mobile/cloud node identity.
- secure transport.
- capability discovery.
- remote execution.

## P2.31 Federated learning if retained in final vision
- actual parameter/gradient aggregation.
- secure aggregation.
- update validation.
- privacy accounting.
- poisoning defense.

## P2.32 Device-aware task routing
- local vs cloud.
- latency.
- privacy.
- battery/power.
- GPU/CPU availability.

---

# P2 — Production persistence / distributed runtime

## P2.33 Unified persistence strategy
- JSON state only where appropriate.
- durable DB schema for critical cognitive state.
- migrations.
- transactions.
- locks.
- versioning.

## P2.34 Backup/restore
- full backup.
- incremental backup.
- point-in-time restore.
- verification.

## P2.35 Distributed worker reliability
- lease ownership.
- crash recovery.
- duplicate execution prevention.
- at-least-once/exactly-once semantics documented per effect.

## P2.36 Network partition handling
- NATS disconnect.
- provider timeout.
- Postgres unavailable.
- split-brain prevention.

## P2.37 Load scaling
- many concurrent sessions.
- many agents.
- long running jobs.
- scheduler throughput.
- memory retrieval throughput.

---

# P2 — Security / adversarial hardening

## P2.38 Real prompt injection suite
- direct injection.
- indirect injection from webpages.
- PDFs.
- memory.
- GitHub issues/README.
- tool outputs.
- email.
- agent-to-agent messages.

## P2.39 Tool abuse suite
- path traversal.
- symlink escape.
- command injection.
- SSRF.
- credential exfiltration.
- malicious MCP server.
- malicious plugin.

## P2.40 Cross-tenant attack suite
- memory.
- filesystem.
- vector store.
- cache.
- prompt cache.
- schedules.
- agent messaging.

## P2.41 Secret protection
- redaction in logs.
- prompt filtering.
- model-provider isolation.
- credential scopes.
- secret rotation.

## P2.42 Security auditability
- every privileged action evidence-bound.
- who/what/when/why/approval/result.

---

# P2 — Observability / operations

## P2.43 Unified telemetry
- task ID.
- agent ID.
- model ID.
- capability ID.
- latency.
- cost.
- tokens.
- retries.
- verification.
- outcome.

## P2.44 Distributed tracing
- user request → task → plan → agent → model → tool → verifier.
- trace propagation through NATS/workers.

## P2.45 Health model
- provider health.
- DB health.
- NATS health.
- queue depth.
- worker health.
- memory health.
- cognitive health.

## P2.46 SLOs
- task success rate.
- p95 latency.
- tool success.
- recovery success.
- memory retrieval quality.
- uptime.

---

# P2 — API / product engineering

## P2.47 Complete OpenAPI
- Generate request/response schemas from real Zod/JSON schema.
- Current generated operations have `x-schema-status: unspecified`; remove that once real schemas are available.
- Standard error schema.
- Auth requirements.
- examples.

## P2.48 API modularization
- Split huge `main.ts` into route modules/controllers.
- shared middleware.
- service layer.
- versioned API policy.

## P2.49 SDKs
- TypeScript SDK.
- Python SDK.
- CLI.
- typed events.

## P2.50 WebSocket/SSE
- task streaming.
- agent events.
- tool events.
- progress.
- approvals.

---

# P2 — Canvas / Desktop / UX

## P2.51 First-run setup
- provider setup.
- local/cloud mode.
- workspace setup.
- permissions.
- security mode.

## P2.52 Unified task UI
- current goal.
- plan.
- active agents.
- current action.
- verification.
- errors/recovery.
- evidence.

## P2.53 Cognitive transparency
- “Why did Aurora do this?”
- selected model.
- selected agent.
- memory used.
- risk level.
- approval status.

## P2.54 Human-in-the-loop
- approval center.
- pending decisions.
- dangerous actions.
- spending approvals.

## P2.55 Desktop hardening
- auto-update.
- crash recovery.
- preload security.
- context isolation.
- CSP.
- secure navigation.
- signed installer.

---

# P3 — Benchmark / “gerçekten en iyi mi?”

## P3.1 Ortak benchmark suite
Aynı görevler:
- coding
- research
- browser
- files
- planning
- multi-agent
- memory
- long-horizon
- recovery
- proactive tasks.

## P3.2 Rakip karşılaştırması
Aynı benchmark üzerinde uygun koşullarda:
- Hermes
- OpenHands
- Codex/Claude Code gibi coding agents
- diğer seçilen agent runtimes.

Ölç:
- task success.
- verified success.
- task completion.
- recovery success.
- latency.
- cost.
- number of interventions.
- memory retention.
- false-success rate.

## P3.3 Ablation tests
- without memory.
- without planning.
- without society.
- without world model.
- without verification.
- without adaptive routing.
- without self-improvement.

Böylece her Aurora katmanının gerçek katkısı ölçülür.

## P3.4 Long-horizon benchmark
- 1h / 6h / 24h / 7d senaryolar.
- restart/recovery.
- memory persistence.
- changing world state.

## P3.5 Adaptive routing benchmark
- cold start.
- measured models.
- changing provider quality.
- cost-aware.
- latency-aware.
- quality-aware.

---

# P3 — Repo / release / engineering hygiene

## P3.6 Clean repo
- generated eval artifacts ignored.
- runtime state ignored.
- duplicate metadata removed.
- stale PDFs removed or moved to docs/archive.
- duplicate MD documents removed/archive.
- filename normalization.
- root README.

## P3.7 Clean Git history
- giant ZIP import commit'i gerekiyorsa tarihsel olarak kalabilir; bundan sonra anlamlı feature commits.
- release tags.
- semantic versioning.

## P3.8 CI gerçek runner doğrulaması
- GitHub Actions'ın gerçekten yeşil olması.
- Docker build gerçekten runner'da.
- Electron e2e gerçek environment'ta.
- concurrency/timeout ölçümü.

## P3.9 Release reproducibility
- source manifest.
- bundle.
- provenance.
- signed attestation.
- artifact verification.
- deterministic build.

## P3.10 Current release evidence regeneration
- all generated docs.
- OpenAPI.
- SBOM/provenance.
- benchmark baselines.
- release checksums.

---

# P3 — Kod kalitesi / bakım

## P3.11 Büyük dosyaları parçala
Özellikle:
- engine.ts
- control-api/main.ts
- App.tsx
- cognitive runtime.

## P3.12 `any` azalt
- core domain types.
- event contracts.
- API responses.
- cognitive state.
- plugin interfaces.

## P3.13 Interface contracts
- ModelProvider contract.
- Capability contract.
- Agent contract.
- Verifier contract.
- Memory contract.
- WorldModel contract.
- Learning contract.

## P3.14 Dependency hygiene
- unused dependencies.
- duplicate router abstractions.
- transitive vulnerabilities.
- version pinning policy.

## P3.15 Deterministic tests
- no random outputs in metrics.
- seeded simulations.
- clock injection.
- fake provider isolation.

---

# P3 — Domain expert sistemi

## P3.16 Real expert knowledge backendleri
- verified source packs.
- retrieval.
- domain-specific validators.

## P3.17 Expert consultation workflow
- domain request.
- specialist selection.
- evidence.
- confidence.
- conflict resolution.

## P3.18 Keyword matchingden semantic routing'e geç
- task embeddings.
- ontology/capability graph.
- learned routing.

---

# P3 — Cognitive economy / resources

## P3.19 Cost intelligence
- provider price.
- tool price.
- compute cost.
- estimated vs actual.

## P3.20 Resource intelligence
- CPU/GPU/RAM.
- queue pressure.
- model availability.
- cloud/local decision.

## P3.21 Budget policy
- per task.
- per agent.
- per day/month.
- emergency override.

---

# P3 — Continuous project awareness

## P3.22 Project watchers
- repo changes.
- CI changes.
- issue changes.
- dependency updates.
- docs changes.

## P3.23 Workspace awareness
- recent files.
- active IDE.
- running services.
- last commands.
- project health.

## P3.24 Project memory
- architecture graph.
- decisions.
- conventions.
- unresolved bugs.
- recurring failures.

---

# P4 — Vision-complete / advanced features

Bunlar Jarvis çekirdeğinin ilk çalışabilir hali için şart olmayabilir; fakat 125 sayfalık Aurora vizyonunun tamamını gerçekleştirmek istiyorsan tamamlanmalıdır.

## P4.1 Memory Palace
- spatial/semantic organization.
- graph navigation.
- importance-driven placement.

## P4.2 Meta-World model
- multiple world models + global meta-state.
- conflict resolution.

## P4.3 Cognitive Health
- overload.
- contradiction load.
- attention fragmentation.
- degraded subsystem detection.

## P4.4 Loop detection
- repeated thought loop.
- repeated failure loop.
- repeated tool loop.
- escalation/abort.

## P4.5 Opportunity Engine
- technology opportunities.
- project improvements.
- new tools.
- research directions.

## P4.6 Risk Engine
- technical.
- security.
- schedule.
- financial/cost.
- user-impact.

## P4.7 Execution reputation
- tool reliability.
- agent reliability.
- workflow reliability.
- environment reliability.

## P4.8 Continuous self-optimization
- planner optimization.
- routing optimization.
- memory optimization.
- context optimization.
- scheduling optimization.
.
## P4.9 Self-created tools
- detect repeated manual workflow.
- generate tool.
- verify tool.
- deploy.
- monitor.
- retire.

## P4.10 Self-created micro-agents
- identify specialization.
- generate agent profile.
- assign allowed capabilities.
- benchmark.
- promote.

---

# Nihai “DONE” kriterleri

Aurora'yı bu backlog'un tamamına yakınını gerçekleştirdikten sonra “hayalimdeki sistem” seviyesinde saymak için aşağıdaki end-to-end kabul senaryolarının tamamının gerçek backendlerle geçmesi gerekir.

## DONE-1 — Uzun görev
Kullanıcı tek cümleyle karmaşık bir iş verir.
Aurora:
- amacı anlar,
- eksikleri sorar,
- plan çıkarır,
- görevleri böler,
- gereken ajanları seçer,
- uygun modeli seçer,
- gerçek araçları kullanır,
- ara sonuçları doğrular,
- hata olursa toparlar,
- sonunda kanıtlı sonuç verir.

## DONE-2 — Coding Jarvis
“Bu repository'deki bug'ı bul, düzelt, test et ve PR hazırla.”
Gerçekten:
- repo okur,
- kodu analiz eder,
- değişiklik yapar,
- test eder,
- güvenlik kontrolü yapar,
- diff üretir,
- PR açar,
- CI sonucunu bekler,
- başarısızsa yeniden çalışır.

## DONE-3 — Research Jarvis
“Bu konu hakkında araştırma yap ve bana kaynaklı rapor hazırla.”
Gerçek kaynakları toplar, doğrular, citation/provenance saklar ve raporu hafızaya alır.

## DONE-4 — Long-term memory
Bugün öğrenilen önemli bir bilgi haftalar sonra ilgili görevde doğru biçimde bulunur; kullanıcı düzelttiğinde eski bilgi kullanılmaz.

## DONE-5 — Adaptive model routing
En az iki gerçek provider/model ile gerçek görevlerde ölçülmüş latency/cost/quality/success geçmişi oluşur ve Aurora sonraki görevlerde bu gerçek veriye göre route seçer.

## DONE-6 — Recovery
Tool başarısız olur.
Aurora:
- hatayı sınıflandırır,
- alternatif tool/model seçer veya planı değiştirir,
- tekrar dener,
- sonucu doğrular,
- failure'ı öğrenme sistemine kaydeder.

## DONE-7 — Capability acquisition
Aurora daha önce sahip olmadığı ama izin verilen bir capability gerektiren görevle karşılaşır; capability'yi kontrollü biçimde üretir/test eder/publish eder ve orijinal görevi tamamlar.

## DONE-8 — Multi-agent society
Karmaşık görevde Aurora gerçekten bir ekip kurar, görevleri dağıtır, sonuçları toplar, çatışmaları çözer ve parent task'a tek bir doğrulanmış sonuç çıkarır.

## DONE-9 — Proactive assistant
Kullanıcı konuşmasa bile izin verilen event'lerden yüksek değerli initiative çıkarır; gereksiz bildirim yapmaz; uygun zamanda kullanıcıyı bilgilendirir.

## DONE-10 — Background cognition
Uyku/düşünme döngüsünde açık problemlere araştırma ve reflection yapabilir; dış dünyaya izinsiz side effect uygulamaz.

## DONE-11 — Real multimodal assistant
Sesli konuşma, ekran/görüntü analizi ve gerçek computer-use çalışır; action verification yapılır.

## DONE-12 — User model
Aurora kullanıcının izin verdiği hedef/tercih/proje/habit bilgisini zaman içinde kullanır; kullanıcı istediğinde görür/düzeltir/siler/export eder.

## DONE-13 — Security
Gerçek/gerçekçi prompt injection, tool abuse, SSRF, secret exfiltration, cross-tenant saldırıları bloklanır; security system hata verdiğinde kritik action fail-closed olur.

## DONE-14 — Crash/restart
Aktif uzun görev restart sonrası kaldığı yerden güvenli şekilde devam eder; duplicate side effect üretmez.

## DONE-15 — Learning
Görev sonuçları gerçekten memory, strategy, model routing, skill veya planning davranışında ölçülebilir değişiklik oluşturur.

## DONE-16 — Self-improvement
Yeni bir sistem varyantı eskisine göre benchmark'ta anlamlı biçimde daha iyi çıkmadan production'a terfi edemez; tüm protected regression suite korunur.

## DONE-17 — No fake success
Unavailable/simulated/unverified/blocked state'leri açıkça gösterilir. Sistem hiçbir zaman backend yokken işlemi yapılmış gibi raporlamaz.

## DONE-18 — Production
CI, Docker, release bundle, provenance, backup/restore, metrics, tracing, alerts, upgrade/rollback ve documentation gerçek bir kurulumda geçer.

## DONE-19 — Comparative benchmark
Aurora'nın güçlü olduğunu mimari iddialarla değil, ortak benchmark'ta ölçebilirsin. Hangi alanda daha iyi/daha kötü olduğu sayısal olarak görünür.

## DONE-20 — Bütünlük
Aşağıdaki tek yaşam döngüsü gerçek olur:

Goal
→ Understand
→ Recall
→ Think
→ Plan
→ Select agents
→ Select model
→ Select capabilities
→ Security
→ Act
→ Observe
→ Verify
→ Recover/Replan
→ Remember
→ Learn
→ Reflect
→ Evolve
→ Next task

Bu yaşam döngüsünün farklı giriş noktalarında değil, Aurora'nın ortak runtime primitive'i olarak bulunması nihai hedefin temel kabulüdür.

---

# Önerilen uygulama sırası

## Faz A — Temiz ve doğru çekirdek
1. Model routing bug'ları ve outcome feedback.
2. Cognitive state isolation.
3. Recovery semantics.
4. Security fail-closed.
5. Typed errors.
6. Maturity/doc measurement.
7. Release/CI/repo hygiene.

## Faz B — Gerçek görev zekâsı
8. Task understanding.
9. Task-specific planner.
10. Real plan execution.
11. Replanning.
12. Reasoning/uncertainty integration.
13. Verification.
14. Long-horizon task manager.

## Faz C — Gerçek hafıza/dünya
15. Production semantic retrieval.
16. Memory consolidation/procedural learning.
17. Learned world model.
18. Multi-world scenarios.
19. Reality alignment.

## Faz D — Gerçek Agent Society
20. Dynamic delegation.
21. Agent lifecycle.
22. Team orchestration.
23. Society governance/economy.

## Faz E — Jarvis uzuvları
24. Computer use.
25. Git/GitHub deep actions.
26. Research backend.
27. Real STT/TTS/vision.
28. Connectors.
29. Device/environment awareness.

## Faz F — Sürekli öğrenme ve evrim
30. Outcome learning.
31. Skill mining.
32. Capability acquisition.
33. Self-debugging.
34. Semantic self-improvement.
35. Meta-learning.

## Faz G — Proaktif yaşam döngüsü
36. Event intake.
37. Initiative scheduler.
38. Watchers.
39. Daily/weekly/monthly briefing.
40. Trust-preserving communication.

## Faz H — Production / scale / proof
41. Unified persistence.
42. Distributed reliability.
43. Security adversarial suite.
44. Observability.
45. API/SDK.
46. Desktop packaging.
47. benchmark lab.
48. competitor benchmark.
49. release/CI.

---

# “Bunların hepsi yapıldığında ne elde edilmiş olur?”

Bu backlog tamamlandığında Aurora yalnızca “çok özellikli agent framework” olmaz.

Hedeflenen son yapı şu olur:

- Kullanıcının hedeflerini uzun süre taşıyan,
- geçmiş deneyimlerden faydalanan,
- dünyayı ve projeleri modelleyen,
- gerektiğinde düşünen ve araştıran,
- karmaşık işleri parçalayan,
- uzman ajanları dinamik biçimde kullanan,
- gerçek bilgisayar ve servislerde kontrollü biçimde hareket eden,
- yaptığı işi doğrulayan,
- başarısız olduğunda toparlayan,
- sonuçları hafızaya alan,
- zaman içinde strateji/skill geliştiren,
- gerektiğinde yeni capability oluşturabilen,
- proaktif davranabilen,
- güvenlik ve insan onayı kurallarına uyan,
- restart/uzun görev/çoklu ajan gibi gerçek operasyon durumlarında dayanıklı kalan,
- modeller değişse bile üst düzey çalışma biçimini koruyan
bir kişisel dijital yardımcı/runtime.

Bu hedef “kurgusal anlamda sınırsız AI” değil; gerçek dünyadaki mümkün dijital işlerin giderek daha geniş bir kümesini güvenilir şekilde üstlenebilen genel amaçlı bir dijital yaşam partneridir.
