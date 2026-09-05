# Forge Agent Development Rules

## 1. Purpose

This document defines the development rules for AI coding agents working on Forge.

Forge is an autonomous engineering agent system.

The purpose of this document is to prevent architectural drift during development.

Every implementation decision must respect these rules.

---

# 2. Project Identity


Forge is not:

- a chatbot
- a coding assistant wrapper
- a modified Pi distribution
- a UI project


Forge is:

An autonomous engineering orchestration system built on top of an Agent Runtime.


The core value of Forge is:

- task lifecycle control
- autonomous planning
- execution management
- verification
- recovery
- memory


---

# 3. Architecture Principle


Forge consists of two major layers.


## Forge Layer

Responsible for:

- understanding engineering goals
- planning tasks
- managing execution lifecycle
- validating results
- deciding completion
- maintaining memory


## Runtime Layer

Responsible for:

- interacting with LLM
- executing turns
- calling tools
- editing files
- running commands


The boundary:


Forge decides:

"What should happen next?"


Runtime decides:

"How should this action be performed?"



---

# 4. Runtime Rules

Pi is part of the Forge stack (vendored at `pi/`) and is evolved directly by
this project. There is no rule forbidding changes to Pi. What must be
preserved is the boundary below: Forge business logic stays out of Pi core,
and Forge core depends only on the runtime interface, never on Pi
implementation. Fixes and features go into Pi where they belong there —
upstreaming to the original repository is encouraged but optional.


## Rule 4.1

Pi is a runtime.

Pi is not Forge.


Do not move Forge business logic into Pi core.


Bad:


Pi Agent Loop

+

Forge State Machine

+

Memory

+

Planner


Good:


Forge

↓

Runtime Interface

↓

Pi Adapter

↓

Pi



---

## Rule 4.2

Runtime must remain replaceable.


The following should not depend on Pi:


- Orchestrator
- Task Model
- Planner
- Observer
- Memory
- Event System



---

## Rule 4.3

Do not directly import Pi implementation into Forge Core.


Forbidden:


core/orchestrator

imports

runtime/pi



Correct:


core

depends on

runtime/interface



---

# 5. Orchestrator Rules


## Rule 5.1

The Orchestrator is the brain of Forge.


All autonomous behavior belongs here.


Examples:


Correct:


"Should we retry this step?"

belongs to:

Orchestrator


Incorrect:


Runtime decides retry.



---

## Rule 5.2

The lifecycle must remain explicit.


Required states:


READY

UNDERSTAND

PLAN

EXECUTE

OBSERVE

FIX

COMPLETE



Do not replace the state machine with:

- hidden prompts
- conversation history
- implicit reasoning



---

## Rule 5.3

Completion is controlled by Forge.


Never allow:


LLM response:

"Task completed"


to directly trigger:


COMPLETE



Completion requires:


- plan steps finished
- success criteria verified



---

# 6. Planning Rules


## Rule 6.1

Plans must be structured data.


Bad:


"Implement authentication"



Good:


Step 1:

Create database model


Success criteria:

- migration exists
- tests pass



---

## Rule 6.2

Plans must be executable and verifiable.


Every step should contain:


- objective
- execution instruction
- success criteria



---

# 7. Observation Rules


## Rule 7.1

Observation is not LLM opinion.


Bad:


"The model thinks the code is correct"



Good:


Verification:


file_exists

file_contains

command_exit_zero

test_pass



---

## Rule 7.2

Observation must produce evidence.


Every verification should answer:


What was checked?

How was it checked?

What was the result?



---

# 8. Memory Rules


## Rule 8.1

Memory belongs to Forge.


Do not rely on:

- chat history
- runtime context
- model memory



---

## Rule 8.2

Memory must have clear ownership.


Allowed:


Project Memory

Task Memory

Experience Memory



Forbidden:


Random text storage without structure.



---

# 9. UI Rules


## Rule 9.1

UI is a projection layer.


The UI displays:

Forge state


The UI does not control:

Forge state



---

## Rule 9.2

Do not build UI before core lifecycle works.


Development order:


1. Orchestrator

2. Runtime Interface

3. Task Model

4. Verification

5. Memory

6. UI



---

# 10. Development Process


Before implementing any feature:


First answer:


1. What problem does this solve?

2. Which layer owns this responsibility?

3. What is the input?

4. What is the output?

5. What events are produced?

6. How is it tested?



---

# 11. Code Organization Rules


Prefer:


small modules

clear ownership

explicit interfaces



Avoid:


large services

cross-layer dependencies

hidden state



---

# 12. Change Rules


When modifying existing code:


Do not:


- rewrite unrelated modules
- introduce unnecessary frameworks
- change architecture without discussion



Prefer:


- minimal changes
- incremental commits
- preserving boundaries



---

# 13. First Development Goal


The first milestone is not a product.


The first milestone is proving:


Forge can control Pi and complete a verified engineering task.


Required flow:


User Task


↓

Create TaskSession


↓

UNDERSTAND


↓

PLAN


↓

EXECUTE using Pi


↓

OBSERVE


↓

COMPLETE



---

# 14. Final Principle


Do not build a smarter chatbot.


Build an engineering system.


The intelligence of Forge comes from:

- explicit lifecycle
- verification
- recovery
- memory
- control


Not from:

- longer prompts
- more tools
- more UI

