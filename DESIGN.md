# Forge Design Specification


# 1. Project Definition

Forge is an autonomous engineering agent system.

Forge is not a coding assistant.

Forge is not a UI wrapper.

Forge is an orchestration system that enables an AI agent to independently execute software engineering tasks.

The goal:

Transform:

"AI helps developers write code"

into:

"AI completes engineering objectives under supervision"



# 2. Core Philosophy

Forge introduces an engineering control layer above the Agent Runtime.

The architecture contains two layers.


## Layer 1: Forge Orchestrator

Responsible for:

- understanding goals
- creating plans
- managing lifecycle
- verifying results
- handling failures
- maintaining memory


## Layer 2: Agent Runtime

Responsible for:

- LLM interaction
- tool calling
- file modification
- command execution
- context management


The fundamental boundary:

Forge decides:

"What should happen next?"


Runtime decides:

"How to execute this action?"



# 3. Runtime Selection

Forge uses Pi as the initial Agent Runtime.

Pi is treated as execution infrastructure.

Forge must not become a modified Pi distribution.

The relationship:


Forge

↓

Runtime Interface

↓

Pi Runtime Adapter

↓

Pi


The purpose of this separation:

- preserve Pi evolution capability
- keep Forge architecture independent
- allow future runtime replacement



# 4. System Architecture


Forge

├── Orchestrator

├── Runtime Layer

├── Task Model

├── Verification System

├── Memory System

├── Event System

└── User Interface



# 5. Orchestrator


Orchestrator is the core of Forge.

It owns the engineering lifecycle.


The lifecycle:


READY

↓

UNDERSTAND

↓

PLAN

↓

EXECUTE

↓

OBSERVE

↓

FIX

↓

COMPLETE



# 6. State Machine


## READY

Create task session.



## UNDERSTAND

Analyze user goal and repository context.

Output:

Understanding Context



## PLAN

Generate structured engineering plan.

Output:

Plan



## EXECUTE

Send execution instructions to runtime.

Runtime performs:

- analysis
- modification
- testing



## OBSERVE

Verify execution result.

Observation must be deterministic.

Examples:

- file exists
- file contains
- test passed
- command succeeded



## FIX

Recover from failure.

Possible actions:

- retry
- adjust plan
- create new execution step



## COMPLETE

Only Forge can declare completion.

Conditions:

- all steps executed
- all success criteria passed



# 7. Runtime Boundary


Forge never directly:

- calls LLM
- executes shell
- edits files


All execution goes through Runtime.



Runtime interface:


createSession()

executeTurn()

subscribeEvents()

closeSession()



# 8. Double Loop Model


Forge has an outer loop.

Outer loop:

Task lifecycle.


UNDERSTAND

↓

PLAN

↓

EXECUTE

↓

OBSERVE

↓

FIX

↓

COMPLETE



Pi has an inner loop.

Inner loop:

Agent execution.


Turn

↓

Tool call

↓

Tool result

↓

Turn result



The two loops are independent.



# 9. Completion Model


The model saying:

"I finished"

does not mean completion.


Completion requires:

Plan validation.


Example:


Step:

Implement authentication API


Success Criteria:


file_exists:

src/auth/controller.ts


command_exit_zero:

npm test


Only after validation:


COMPLETE



# 10. Task Model


TaskSession:


id

goal

state

plan

observations

runtimeSessionId

createdAt

updatedAt


TaskSession is the source of truth.



# 11. Plan Model


Plan is structured data.

Not only natural language.


Example:


Step:

Create user API


Success Criteria:


- controller file exists
- unit tests pass
- API responds correctly



# 12. Memory System


Memory belongs to Forge.

Not runtime.


Memory types:


## Project Memory

Repository knowledge.

Examples:

- architecture decisions
- coding conventions


## Task Memory

Current task history.


## Experience Memory

General solutions and failure patterns.



# 13. Event System


Forge exposes lifecycle events.


Events:


state_changed

plan_created

step_started

step_verified

fix_started

completed

failed


Runtime events remain internal.


Examples:


tool_call

file_change

terminal_output



# 14. Development Rules


Rule 1:

Do not build UI before core lifecycle works.


Rule 2:

Do not solve architecture problems with prompts.


Rule 3:

Every autonomous behavior must have:

- state
- input
- output
- verification


Rule 4:

Keep runtime replaceable.



# 15. First Milestone


The first version should achieve:


User:

"Create a hello world API"


Forge:


UNDERSTAND

↓

PLAN

↓

EXECUTE

↓

OBSERVE

↓

COMPLETE


No UI.

No memory.

No multi-agent.


Only prove:


Forge can control Pi and complete a verified engineering task.

