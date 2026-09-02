# Forge Memory System Specification


# 1. Purpose


The Memory System enables Forge to accumulate engineering knowledge over time.


The goal:


Transform Forge from a stateless coding agent into a continuously improving engineering system.



Memory allows Forge to remember:


- project architecture
- engineering decisions
- previous failures
- successful solutions
- user preferences
- repository knowledge



---

# 2. Core Philosophy


Memory is owned by Forge.



Memory is NOT:


- LLM conversation history
- Runtime context
- Prompt injection
- Temporary cache



Memory is structured knowledge.



---

# 3. Memory Architecture



Forge Memory consists of three layers.



Project Memory


↓

Task Memory


↓

Experience Memory



---

# 4. Project Memory



## Purpose



Store knowledge about a specific repository.



Examples:



Architecture:



"This project uses hexagonal architecture"



Coding conventions:



"All services must use dependency injection"



Important locations:



"Authentication logic is located in security module"



---

# 5. Project Memory Characteristics



Project Memory:



- long lived
- repository scoped
- reusable across tasks



Example:



Task 1:


Implement login



Task 2:


Implement permissions



Both can reuse:


"Authentication module structure"



---

# 6. Task Memory



## Purpose



Store knowledge related to one engineering task.



Examples:



- execution history
- failed attempts
- decisions
- intermediate findings



Example:



Task:


"Upgrade Spring Boot version"



Memory:


"Previous attempt failed because dependency X is incompatible"



---

# 7. Experience Memory



## Purpose



Store general engineering experience.



Examples:



Failure patterns:



"Database migration failures usually require schema rollback"



Solutions:



"Use strategy pattern for dynamic rule engine"



---

# 8. Memory Lifecycle



Memory follows the task lifecycle.



Before execution:



Retrieve relevant memory.



During execution:



Create temporary memories.



After completion:



Extract valuable knowledge.



---

# 9. Memory Flow



Task Start:



User Goal


↓

Memory Retrieval


↓

Context Injection


↓

Execution



Task Complete:



Execution History


↓

Memory Extraction


↓

Memory Storage



---

# 10. Memory Retrieval


Memory retrieval should happen before planning.



Reason:



Planning quality depends on existing knowledge.



Example:



User:


"Add payment feature"



Forge retrieves:



Project Memory:


"Payment module uses domain service pattern"



Experience Memory:


"Payment APIs require idempotency"



Then creates plan.



---

# 11. Memory Writing



Memory should not blindly store everything.



Bad:



Save every conversation message.



Reason:


Creates noise.



---

Good:


Store validated knowledge.



Examples:



Architecture decision:



"The project uses PostgreSQL"



Verified solution:



"Redis cache requires TTL configuration"



Important failure:



"Migration script cannot remove existing columns"



---

# 12. Memory Confidence



Each memory item should have confidence.



Example:



{

content:

"Authentication uses JWT"


confidence:

0.9


source:

"verified code"


}



---

# 13. Memory Source


Every memory should record origin.



Possible sources:



## User Input



Example:


"The team prefers REST API"



## Repository Analysis



Example:


"Detected Spring Boot structure"



## Task Result



Example:


"Successful implementation"



## Human Confirmation



Example:


"Developer approved"



---

# 14. Memory Validation



Memory should not automatically become truth.



Before storing:



Check:


- Is it reusable?
- Is it stable?
- Is it verified?



---

# 15. Memory Storage Model



Initial implementation:



SQLite



Tables:



memory_item


Fields:



id


type


content


source


confidence


created_at


updated_at



---

# 16. Memory Query



Memory retrieval should support:



By repository:



"project architecture"



By topic:



"authentication"



By failure:



"previous build errors"



---

# 17. Memory Integration With Orchestrator



Memory participates in:



UNDERSTAND:



Retrieve repository knowledge.



PLAN:



Improve planning.



FIX:



Learn from failures.



COMPLETE:



Extract reusable knowledge.



---

# 18. Memory Integration Rules



Rule 1:



Memory must not control execution.



Memory provides knowledge.



Orchestrator makes decisions.



---

Rule 2:



Memory must not replace verification.



A memory saying:


"Tests usually pass"



does not prove:



Tests passed.



---

Rule 3:



Memory should improve future decisions.



Not modify past facts.



---

# 19. Anti Patterns



## Anti Pattern 1



Store all conversation history.



Problem:


Large noise.



---

## Anti Pattern 2



Let LLM decide memory blindly.



Problem:


Hallucinated knowledge.



---

## Anti Pattern 3



Use memory as hidden state.



Problem:


Impossible debugging.



---

# 20. Future Evolution



Possible extensions:



Vector search


Knowledge graph


Repository dependency graph


Team knowledge sharing


Automatic architecture documentation



---

# Summary



Runtime memory:

temporary execution context.



Forge Memory:

long-term engineering knowledge.



The goal:


Every completed task should make Forge better at future engineering work.



