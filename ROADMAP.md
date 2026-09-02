# Forge Development Roadmap


# 1. Development Philosophy


Forge development follows a vertical slice approach.


The goal is not to build all components at once.


The goal is to prove the complete autonomous engineering loop step by step.



Each phase must produce a working system.



The development priority:


Core capability

↓

Runtime integration

↓

Verification

↓

Memory

↓

User experience



---

# 2. Phase 0 - Project Foundation


## Goal


Create a clean Forge project foundation.



## Scope


Implement:


- repository structure
- TypeScript environment
- package management
- basic build system
- development scripts



## Do not implement:


- UI
- memory
- multi-agent
- cloud service



## Expected Result


The project can:

- compile
- run tests
- execute a basic CLI command



---

# 3. Phase 1 - Minimal Autonomous Loop


## Goal


Prove Forge can control an Agent Runtime.



This is the first important milestone.



The system should support:


User Task


↓

TaskSession


↓

UNDERSTAND


↓

PLAN


↓

EXECUTE


↓

OBSERVE


↓

COMPLETE



---

## Required Components


### Task Model


Implement:


- TaskSession
- Plan
- PlanStep
- Observation



---

### Orchestrator


Implement:


- lifecycle state machine
- state transitions
- execution flow



---

### Runtime Interface


Create:


AgentRuntime interface



Initial implementation:


Pi Runtime Adapter



---

### Verification


Implement minimal validators:


file_exists

command_exit_zero



---

## Example Task


Input:


"Create hello world API"



Expected flow:


UNDERSTAND:

Analyze project


PLAN:

Create server file


EXECUTE:

Pi modifies files


OBSERVE:

Check file exists


COMPLETE:



---

# 4. Phase 2 - Execution Reliability


## Goal


Make Forge capable of recovering from failures.



---

## Add:


## FIX State


Support:


EXECUTE

↓

OBSERVE

↓

FAIL

↓

FIX

↓

EXECUTE



---

## Retry Management


Implement:


Step retry limit


Example:


maximum 3 attempts



Task retry limit


Example:


maximum 10 fixes



Deadline control


Example:


maximum execution time



---

## Failure Recording


Store:


- failed step
- error information
- previous attempts
- recovery actions



---

# 5. Phase 3 - Structured Planning


## Goal


Improve planning capability.



Add:


- multi-step plans
- step dependencies
- plan versioning
- dynamic replanning



---

## Plan Evolution


Initial:


Static plan



Future:


Adaptive plan



Example:


Original plan:


Step 1

Step 2

Step 3



After failure:


Step 2 replaced

Step 4 added



---

# 6. Phase 4 - Memory System


## Goal


Allow Forge to accumulate engineering knowledge.



---

## Project Memory


Store:


- architecture decisions
- repository structure
- coding patterns
- important constraints



Example:


"This project uses repository pattern"

"Authentication logic is located in service layer"



---

## Task Memory


Store:


- previous executions
- failures
- solutions



---

## Memory Lifecycle


Before task:


Retrieve relevant memory



During task:


Update temporary memory



After task:


Persist useful knowledge



---

# 7. Phase 5 - User Interface


## Goal


Create a Codex-style engineering interface.



Important:


UI is a visualization of Forge lifecycle.



UI must show:


- current task
- plan
- execution progress
- verification result
- failures
- memory



---

## UI must not:


- become source of state
- contain business logic
- replace Orchestrator



---

# 8. Phase 6 - Advanced Capabilities


Future capabilities:



## Multiple Runtime Support


Example:


Pi

OpenCode

Custom Runtime



---

## Human Approval


Support checkpoints:


Before execution

Before destructive operations

Before completion



---

## Background Tasks


Support:


Long running tasks

Scheduled execution

Remote execution



---

## Multi Agent


Possible future:


Planner Agent

Executor Agent

Reviewer Agent



This should only happen after single-agent architecture is stable.



---

# 9. Current Priority


The current highest priority is:


Build the smallest complete autonomous engineering loop.



Not priority:


- UI polish
- multi-agent
- cloud
- user accounts
- collaboration



---

# 10. Success Criteria


Forge Phase 1 is successful when:


A user can give a software engineering task.


Forge can:


1. Understand the repository

2. Create a plan

3. Ask Pi to execute

4. Verify the result

5. Complete only after validation



The system must work without human manually guiding every step.



