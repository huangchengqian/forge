# Forge Runtime Pi Integration Specification


# 1. Purpose


This document defines how Forge integrates with Pi Runtime.


The goal:


Use Pi as an execution engine while keeping Forge as an independent autonomous orchestration system.



The key principle:


Pi executes.

Forge decides.



---

# 2. Integration Philosophy



Forge is not a fork of Pi.



Forge does not replace Pi's Agent Loop.



Forge builds an outer engineering control layer around Pi.



Architecture:



Forge

|

Runtime Interface

|

Pi Runtime Adapter

|

Pi Agent Engine

|

Tools / Files / Shell / Model



---

# 3. Responsibility Separation



## Forge Responsibilities



Forge owns:



- Task lifecycle

- Planning

- Step management

- Verification

- Retry strategy

- Completion decision

- Memory



---


## Pi Responsibilities



Pi owns:



- LLM interaction

- Context management

- Tool calling

- File operations

- Command execution

- Agent turn loop



---

# 4. Forbidden Coupling



The following designs are forbidden.



## Forbidden 1



Forge directly depends on Pi internal classes.



Example:



Wrong:



core/orchestrator


imports


pi/internal/agent.ts



Reason:


This prevents runtime replacement.



---

## Forbidden 2



Move Forge state machine into Pi.



Wrong:



Pi Agent Loop:


Think

↓

Tool

↓

Observe

↓

Complete



Reason:


Pi should not own engineering lifecycle.



---

## Forbidden 3



Use Pi conversation history as Forge state.



Wrong:



messages[] = task state



Reason:


Conversation is not reliable state.



---

# 5. Runtime Interface



Forge communicates through an abstract runtime interface.



Conceptual interface:



interface AgentRuntime {


createSession()


executeTurn()


streamEvents()


closeSession()


}



---

# 6. Runtime Session Model



Forge owns:



TaskSession



Pi owns:



RuntimeSession



Relationship:



Forge TaskSession


runtimeSessionId


↓

Pi Runtime Session



---

# 7. Session Creation Flow



User creates task.



Flow:



User Task


↓

Forge creates TaskSession


↓

Forge requests Pi Runtime Session


↓

Pi returns runtimeSessionId


↓

Forge stores reference



Example:



TaskSession:



{

id:

"task-001",


runtimeSessionId:

"pi-session-001"

}



---

# 8. Turn Execution Flow



A Forge Step execution:



Step:


"Implement user authentication service"



Flow:



Forge


↓

Generate execution instruction


↓

Runtime Interface


↓

Pi Runtime Adapter


↓

Pi execute turn


↓

Return execution result


↓

Forge Observe



---

# 9. Instruction Generation



Forge generates task-oriented instructions.



Example:



Do:



"Implement Step 2 of the current plan.

Modify authentication service.

Follow existing repository patterns.

Run relevant tests after modification."



Do not:



"Please solve the whole user request."



Reason:


Forge controls scope.



---

# 10. Runtime Result Model



Pi returns execution information.



Example:



TurnResult:



{

success:true,


summary:

"Implemented authentication service",


changedFiles:


[

"src/AuthService.java"

],


toolEvents:


[...]

}



Important:



success means:


The runtime completed execution.



It does NOT mean:


The engineering task is complete.



---

# 11. Event Handling



Pi produces detailed execution events.



Examples:



tool_call


tool_result


file_changed


command_output


message_stream



These belong to Runtime.



Forge should not treat them as lifecycle state.



---

# 12. Event Translation



Pi events may be translated.



Example:



Pi:



file_changed



↓

Forge:



runtime_progress



But Forge lifecycle remains separate.



Example:



Forge:



step_started


step_verified


completed



---

# 13. Multiple Runtime Support



The architecture should support:



Forge


|

Runtime Interface


|

+----------------+

|

Pi Runtime


|

Open Source Runtime


|

Future Runtime



The Orchestrator should not change.



---

# 14. Pi Adapter Responsibilities



The adapter converts Pi concepts into Forge concepts.



Responsibilities:



- create Pi sessions

- send instructions

- collect execution results

- translate events

- handle runtime errors



The adapter should remain thin.



---

# 15. Adapter Non Responsibilities



The adapter should not:



- create plans

- verify success criteria

- decide completion

- manage retries



---

# 16. Development Strategy



Initial implementation:



Phase 1:


Create minimal Pi adapter.



Support:



createSession


executeTurn


receive result



Do not implement:



- advanced streaming

- complex event mapping

- multi runtime



---

# 17. Testing Strategy



Runtime integration tests should verify:



1. Forge can create Pi session


2. Forge can send execution instruction


3. Pi can modify workspace


4. Forge receives result


5. Forge can verify result



---

# 18. Future Evolution



Possible future runtimes:



Claude Code Runtime


OpenCode Runtime


Local Model Runtime


Remote Worker Runtime



The abstraction should remain stable.



---

# Summary



Pi is Forge's execution engine.


Forge is the autonomous engineering controller.



The relationship:



Pi gives Forge hands.


Forge gives Pi purpose.



The success of Forge depends on maintaining this boundary.

