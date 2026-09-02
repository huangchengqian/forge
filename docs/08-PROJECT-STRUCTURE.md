# Forge Project Structure Specification


# 1. Purpose


This document defines the recommended repository structure for Forge.


The purpose:


- keep architecture boundaries clear
- prevent cross-layer coupling
- make future expansion predictable



---

# 2. High Level Structure



forge/


├── core/


├── orchestrator/


├── runtime/


├── verification/


├── memory/


├── events/


├── persistence/


├── cli/


├── ui/


├── docs/


└── tests/



---

# 3. Core Package


Location:


core/



Purpose:


Contains fundamental domain models and shared abstractions.



Core should not depend on:


- Runtime
- UI
- Persistence
- CLI



Core contains:


- Task models
- Plan models
- State definitions
- Common interfaces



Example:



core/


├── task/


│   ├── task-session.ts


│   ├── plan.ts


│   └── step.ts



├── state/


│   └── task-state.ts



└── types/



---

# 4. Orchestrator Package


Location:


orchestrator/



Purpose:


Contains Forge autonomous lifecycle logic.



Responsibilities:


- state transitions
- execution flow
- planning coordination
- recovery handling



Example:



orchestrator/


├── engine.ts


├── state-machine.ts


├── planner.ts


├── executor.ts


└── recovery.ts



---

# 5. Runtime Package


Location:


runtime/



Purpose:


Provides execution capability.



The runtime layer abstracts external agent engines.



Structure:



runtime/


├── interface.ts


├── pi/


│   ├── pi-adapter.ts


│   ├── pi-session.ts


│   └── pi-events.ts



└── types.ts



---

# 6. Runtime Interface Rule


All runtimes must implement the same interface.



Example:



AgentRuntime



Required capabilities:



createSession()


executeTurn()


streamEvents()


closeSession()



---

# 7. Verification Package


Location:


verification/



Purpose:


Provide deterministic task validation.



Responsibilities:


- evaluate success criteria
- produce verification results
- create observations



Structure:



verification/


├── validator.ts


├── criteria/


│   ├── file-exists.ts


│   ├── file-contains.ts


│   ├── command-exit-zero.ts


│   └── test-pass.ts



└── result.ts



---

# 8. Memory Package


Location:


memory/



Purpose:


Provide long-term engineering knowledge.



Responsibilities:


- memory retrieval
- memory extraction
- memory storage



Structure:



memory/


├── memory-service.ts


├── retriever.ts


├── extractor.ts


├── types.ts


└── storage.ts



---

# 9. Event Package


Location:


events/



Purpose:


Provide communication between Forge components.



Responsibilities:


- publish events
- subscribe events
- event persistence



Structure:



events/


├── event-bus.ts


├── event-types.ts


└── publisher.ts



---

# 10. Persistence Package


Location:


persistence/



Purpose:


Store Forge state.



Initial responsibilities:


- TaskSession storage
- Plan storage
- Observation storage
- Memory storage



Possible implementation:


SQLite



Structure:



persistence/


├── database.ts


├── task-repository.ts


├── memory-repository.ts


└── migrations/



---

# 11. CLI Package


Location:


cli/



Purpose:


Provide command line interaction.



Responsibilities:


- create tasks
- inspect status
- start execution
- debug



Example:



forge task create


forge task status


forge task logs



---

# 12. UI Package


Location:


ui/



Purpose:


Human interface.



Important:


UI is a projection layer.



UI does not contain:


- planning logic
- execution logic
- verification logic



Structure:



ui/


├── components/


├── stores/


├── api/


└── views/



---

# 13. Dependency Direction


The dependency direction must be:



core


↑


orchestrator


↑


runtime


verification


memory


events


persistence


↑


cli


ui



Lower layers must not depend on higher layers.



---

# 14. Forbidden Dependencies



Forbidden:



runtime


imports


orchestrator



Reason:


Runtime should remain generic.



---



Forbidden:



ui


imports


core implementation details



Reason:


UI should consume events and APIs.



---



Forbidden:



memory


controls


orchestrator



Reason:


Memory provides knowledge.

It does not make decisions.



---

# 15. Package Communication



Recommended communication:



Orchestrator


uses:


Runtime Interface



Orchestrator


uses:


Verification Interface



Orchestrator


publishes:


Events



UI


consumes:


Events



Memory


subscribes:


Events



---

# 16. Testing Structure



tests/



├── core/


├── orchestrator/


├── runtime/


├── verification/


├── memory/


└── integration/



---

# 17. Initial Implementation Scope



The first implementation should only require:



core/


orchestrator/


runtime/pi/


verification/


events/


persistence/



Do not build:


ui


memory intelligence


multi-runtime


before the autonomous loop works.



---

# 18. Future Expansion



Possible future modules:



agents/


multi-agent coordination



scheduler/


background tasks



cloud/


remote execution



marketplace/


skills ecosystem



---

# Summary


Forge repository structure follows one principle:


Separate decision making from execution.



Core defines truth.


Orchestrator defines behavior.


Runtime performs actions.


Verification defines success.


Memory preserves knowledge.


Events connect the system.


UI exposes understanding.

