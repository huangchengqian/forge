# Forge Event System Specification


# 1. Purpose


The Event System defines how internal state changes are communicated across Forge components.


The purpose:


- decouple components
- support real-time UI
- provide execution history
- enable debugging
- support future distributed execution



---

# 2. Core Principle


Events are observations of system changes.


Events are not commands.



The ownership model:



Component


creates events



↓

Event Bus



↓

Consumers



Examples:



UI consumes events.


Memory consumes events.


Logger consumes events.



---

# 3. Two Event Layers


Forge contains two independent event systems.



## Layer 1: Runtime Events


Owned by Pi Runtime.



Purpose:


Describe execution details.



Examples:



tool_call


tool_result


file_changed


command_output


message_stream



---


## Layer 2: Forge Lifecycle Events


Owned by Forge Orchestrator.



Purpose:


Describe engineering progress.



Examples:



state_changed


plan_created


step_started


step_verified


fix_started


completed


failed



---

# 4. Event Boundary



Runtime events answer:



"What is the agent doing?"



Forge events answer:



"Where is the engineering task?"



Example:



Runtime:



file_changed:

src/AuthService.ts



Forge:



step_started:

Implement authentication service



step_verified:

Authentication service completed



---

# 5. Event Architecture


            Forge Core


                |

                |

          Event Publisher


                |

          Event Bus


    +-----------+-----------+

    |                       |


    v                       v


  UI                    Memory


  Logger                Analytics



---

# 6. Event Format


All Forge events should share a common envelope.



Example:



{

id:

"event-001",


type:

"step_started",


taskId:

"task-001",


timestamp:

"2026-08-22T10:00:00Z",


payload:{}

}



---

# 7. Required Fields



## id


Unique event identifier.



Purpose:


- tracing
- replay
- debugging



---

## type


Event name.



Example:



state_changed



---

## taskId


Associated TaskSession.



---

## timestamp


Creation time.



---

## payload


Event-specific data.



---

# 8. Lifecycle Events



## state_changed



Purpose:


Task state transition.



Example:



{

from:

"PLAN",


to:

"EXECUTE"


}



---

## plan_created



Purpose:


A new execution plan was generated.



Payload:



{

planId:

"plan-001",


steps:

3


}



---

## step_started



Purpose:


Execution of a plan step begins.



Payload:



{

stepId:

"step-001",


description:

"Create API controller"


}



---

## step_verified



Purpose:


A step has been verified.



Payload:



{

stepId:

"step-001",


result:

"PASS"


}



---

## fix_started



Purpose:


Recovery begins.



Payload:



{

failedStep:

"step-001",


reason:

"test failure"


}



---

## completed



Purpose:


Task completed.



Payload:



{

taskId:

"task-001"


}



---

## failed



Purpose:


Task failed permanently.



Payload:



{

reason:

"retry limit exceeded"


}



---

# 9. Event Ordering


Events should preserve lifecycle order.



Example:



state_changed:

PLAN -> EXECUTE



↓

step_started



↓

step_verified



↓

state_changed:

EXECUTE -> OBSERVE



---

# 10. Event Persistence


Events should optionally support persistence.



Initial:


In-memory event bus



Future:


Persistent event store



Benefits:



- replay UI state
- debugging
- audit history



---

# 11. UI Usage


The UI should be a projection of events.



Example:



Event:


step_started



UI:


Show running step.



Event:


step_verified PASS



UI:


Mark step completed.



Event:


fix_started



UI:


Show recovery process.



---

# 12. Memory Usage


Memory system can subscribe to events.



Examples:



completed event:


Extract useful project knowledge.



failed event:


Record failure pattern.



---

# 13. Event Filtering


Consumers should subscribe only to required events.



Example:



UI:


needs:


state_changed


step_started


step_verified



Memory:


needs:


completed


failed



---

# 14. Anti Patterns



## Anti Pattern 1


UI directly reads internal Orchestrator state.



Wrong.



Reason:


Creates tight coupling.



---

## Anti Pattern 2


Runtime events control Forge lifecycle.



Wrong.



Example:



tool_result success


↓

task completed



Forbidden.



---

## Anti Pattern 3


Store only final result.



Wrong.



Reason:


Execution history is valuable.



---

# 15. Future Extensions



Possible future events:



human_approval_required


memory_updated


budget_exceeded


agent_delegated


subtask_created



---

# Summary



Runtime events show execution details.



Forge lifecycle events show engineering progress.



The UI should visualize Forge lifecycle.


The Runtime should remain an implementation detail.



Events are the bridge between autonomy and user experience.

