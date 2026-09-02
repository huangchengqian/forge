# Forge UI Projection Design


# 1. Purpose


The Forge UI is the human interface for observing and controlling autonomous engineering tasks.


The UI is not a chatbot interface.


The UI is not the source of truth.


The UI is a projection of Forge internal state.



---

# 2. Core Philosophy


Traditional coding assistants:


User

↓

Chat

↓

Agent response



The user only sees conversation.



Problem:


The user cannot clearly understand:


- what the agent is doing
- why it is doing it
- whether it succeeded
- why it failed



---

Forge model:


User

↓

Task

↓

Plan

↓

Execution

↓

Verification

↓

Completion



The UI should expose the engineering lifecycle.



---

# 3. UI Responsibility


The UI should answer five questions.



## Question 1


What is Forge trying to accomplish?



Show:


Task Goal



Example:



"Implement OAuth authentication"



---

## Question 2


What is Forge planning to do?



Show:


Structured Plan



Example:



Step 1:

Analyze authentication module



Step 2:

Implement service layer



Step 3:

Run tests



---

## Question 3


What is Forge doing now?



Show:


Current Execution State



Example:



EXECUTE


Current Step:


"Implement authentication service"



---

## Question 4


Why does Forge think it is complete?



Show:


Verification Evidence



Example:



PASS


file_exists:

src/AuthService.java



PASS


command_exit_zero:

npm test



---

## Question 5


What did Forge learn?



Show:


Memory Updates



Example:



Added Project Memory:


"Authentication module follows JWT pattern"



---

# 4. UI Architecture


The UI should be divided into four primary areas.

+------------------------------------------------+
| Task Header |
+------------------------------------------------+
| |
| Timeline | Workspace |
| | |
| | |
+------------------------------------------------+
| Plan | Verification |
+------------------------------------------------+
| Memory / Context |
+------------------------------------------------+




---

# 5. Task Header


Purpose:


Display current task identity.



Contains:



Task name



Current state



Execution time



Resource usage



Example:



Task:


Implement payment API



State:


EXECUTE



Duration:


12 minutes



---

# 6. Timeline Panel


The Timeline is the primary interaction surface.



It displays Forge lifecycle events.



Source:


Forge Event System



Example:

UNDERSTAND
Analyzed repository structure
PLAN
Created 5 step implementation plan
EXECUTE
Implementing payment service
OBSERVE
Running tests
FIX
Resolving dependency conflict




---

# 7. Timeline Rules


Timeline should show:


Important lifecycle events.



Timeline should not be flooded by:


- every token
- every tool call
- raw logs



Detailed execution can be expanded.



---

# 8. Plan Panel
Plan represents Forge intention.
Each step shows:
Status:
PENDING
RUNNING
COMPLETED
FAILED

Example:

[x] Analyze repository
[x] Create database model
[>] Implement service
[ ] Add tests




---

# 9. Execution Panel


Execution panel shows runtime activity.



Source:


Pi Runtime events



Examples:



Tool:


Read file


Command:


npm test


Changed:


src/UserService.ts



---

# 10. Verification Panel

Verification is first-class UI information.
Show:
Criteria
Result
Evidence
Example:
Authentication API
✓ file_exists
src/AuthController.ts
✓ command_exit_zero
npm test




---

# 11. Failure Display
Failures should be visible.
Do not hide failures behind:
"Agent retrying"
Show:
Step failed:
Run tests
Reason:
Database migration error
Action:
Forge entered FIX state




---

# 12. Memory Panel


Memory shows accumulated knowledge.



Examples:



Project Memory:



"Repository uses layered architecture"



Task Memory:



"Previous API implementation failed due to missing validation"



---

# 13. User Interaction Model


The user is not constantly prompting the agent.



The interaction model:


User:

Define objective



↓

Forge:

Execute autonomously



↓

User:

Observe


↓

User:

Approve / Intervene when necessary



---

# 14. Human Control Points


Future UI should support:



Pause


Resume


Approve


Reject


Modify Plan



But the default mode is autonomous execution.



---

# 15. Event Driven UI


The UI should consume events.



Architecture:



Forge Event Bus


↓

UI Event Client


↓

UI State Store


↓

Components



---

# 16. State Management


UI state should be derived from Forge events.



The UI should not invent:


- task status
- completion state
- verification result



---

# 17. Recommended Frontend Structure



Example:



ui/


components/


TaskHeader


Timeline


PlanView


ExecutionView


VerificationPanel


MemoryPanel



stores/


taskStore


eventStore



api/


forgeClient



---

# 18. Anti Patterns



## Anti Pattern 1


Build a ChatGPT clone.



Problem:


Loses Forge advantage.



---

## Anti Pattern 2


Only show terminal logs.



Problem:


User cannot understand progress.



---

## Anti Pattern 3


UI decides task status.



Problem:


Breaks architecture.



---

# 19. Future Evolution



Possible features:



Multi-task dashboard


Remote execution monitoring


Human approval workflow


Team collaboration


Task replay



---

# Summary
Forge UI is not a chat interface.
It is a visualization system for autonomous engineering.
The UI should make visible:
Intent
Plan
Execution
Evidence
Memory
This visibility is the foundation of human trust in autonomous agents.




---

# 12. Memory Panel


Memory shows accumulated knowledge.



Examples:



Project Memory:



"Repository uses layered architecture"



Task Memory:



"Previous API implementation failed due to missing validation"



---

# 13. User Interaction Model


The user is not constantly prompting the agent.



The interaction model:


User:

Define objective



↓

Forge:

Execute autonomously



↓

User:

Observe


↓

User:

Approve / Intervene when necessary



---

# 14. Human Control Points


Future UI should support:



Pause


Resume


Approve


Reject


Modify Plan



But the default mode is autonomous execution.



---

# 15. Event Driven UI


The UI should consume events.



Architecture:



Forge Event Bus


↓

UI Event Client


↓

UI State Store


↓

Components



---

# 16. State Management


UI state should be derived from Forge events.



The UI should not invent:


- task status
- completion state
- verification result



---

# 17. Recommended Frontend Structure



Example:



ui/


components/


TaskHeader


Timeline


PlanView


ExecutionView


VerificationPanel


MemoryPanel



stores/


taskStore


eventStore



api/


forgeClient



---

# 18. Anti Patterns



## Anti Pattern 1


Build a ChatGPT clone.



Problem:


Loses Forge advantage.



---

## Anti Pattern 2


Only show terminal logs.



Problem:


User cannot understand progress.



---

## Anti Pattern 3


UI decides task status.



Problem:


Breaks architecture.



---

# 19. Future Evolution



Possible features:



Multi-task dashboard


Remote execution monitoring


Human approval workflow


Team collaboration


Task replay



---

# Summary


Forge UI is not a chat interface.


It is a visualization system for autonomous engineering.


The UI should make visible:


Intent


Plan


Execution


Evidence


Memory


This visibility is the foundation of human trust in autonomous agents.



