# Forge Task Model Specification


# 1. Purpose


Task Model defines the core data structures of Forge.


The Task is the first-class object.


A conversation is only an interaction method.


Forge does not manage conversations.

Forge manages engineering tasks.



---

# 2. Core Concept


A Forge Task represents an autonomous engineering objective.


Example:


User:


"Add OAuth authentication support"



Forge Task:


Goal:

Implement OAuth authentication


Lifecycle:

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

# 3. Source of Truth


TaskSession is the single source of truth.


The source of truth hierarchy:


TaskSession

↓

Plan

↓

Step

↓

Observation

↓

Runtime Session



Runtime conversation history is not authoritative.



---

# 4. TaskSession


TaskSession represents one complete engineering task.



Conceptual model:


TaskSession {

    id

    goal

    state

    plan

    observations

    runtimeSession

    metadata

}



---

# 5. TaskSession Fields


## id


Unique identifier.


Purpose:


- persistence
- recovery
- tracing



Example:


task_20260822_001



---

## goal


Original user objective.



Example:


"Implement payment refund API"



The goal should remain unchanged during execution.



---

## state


Current lifecycle state.



Allowed values:


READY

UNDERSTAND

PLAN

EXECUTE

OBSERVE

FIX

COMPLETE

FAILED



---

## plan


Current execution plan.



A task may have multiple plan versions.



Example:


plan.v1

plan.v2



---

## observations


Verification history.



Observations are append-only.



Never delete previous observations.



Reason:


Failure history is valuable for:

- debugging
- recovery
- learning



---

## runtimeSessionId


Reference to the underlying runtime session.



Example:


Pi session id



Important:


Runtime session belongs to runtime.

TaskSession belongs to Forge.



---

## metadata


Additional task information.



Examples:


- repository path
- user preferences
- execution options



---

# 6. Plan Model


Plan describes how Forge intends to complete a task.



Plan is structured data.



Plan is not only natural language.



A Plan contains:


- objective
- steps
- dependencies
- success criteria



---

# 7. Plan Structure



Conceptual model:


Plan {


    id


    version


    objective


    steps[]


    status


}



---

# 8. Plan Step


A Step represents one executable engineering unit.



Example:


Task:


"Add authentication"



Plan:



Step 1:

Create user model



Step 2:

Implement authentication service



Step 3:

Add API endpoint



---

# 9. Step Structure



PlanStep {


    id


    description


    status


    attempts


    successCriteria[]


}



---

# 10. Step Fields



## id


Unique step identifier.



Example:


step_auth_service



---

## description


Human-readable objective.



Example:


"Implement authentication service"



This describes intent.

It does not define completion.



---

## status


Possible values:


PENDING

RUNNING

VERIFYING

COMPLETED

FAILED



---

## attempts


Number of execution attempts.



Used for:


- retry control
- failure analysis



Example:


attempts: 2



---

## successCriteria


Conditions required for completion.



This is the most important field.



---

# 11. Success Criteria


Completion must be based on structured validation.



Never:


"The model believes this is complete"



Always:


"Defined conditions are satisfied"



---

# 12. Criteria Types



Initial supported types:



## file_exists



Example:


{

type:

"file_exists"


value:

"src/auth/service.ts"


}



Meaning:


The file must exist.



---

## file_contains



Example:


{

type:

"file_contains"


value:

"src/auth/service.ts:class AuthService"


}



Meaning:


The file must contain expected content.



---

## command_exit_zero



Example:


{

type:

"command_exit_zero"


value:

"npm test"


}



Meaning:


The command must exit successfully.



---

## test_pass



Example:


{

type:

"test_pass"


value:

"AuthServiceTest"


}



Meaning:


Specified test must pass.



---

# 13. Observation Model


Observation stores verification results.



Observation is evidence.



Conceptual model:


Observation {


    id


    stepId


    result


    criteriaResults


    timestamp


}



---

# 14. Criteria Result


Each success criterion produces a result.



Example:


Criteria:


file_exists:

src/auth.ts



Result:


passed:

true



Message:


"File exists"



---

# 15. Task Lifecycle Example



Initial:


TaskSession


state:

READY



After understanding:


state:

UNDERSTAND



After planning:


state:

PLAN


plan:

3 steps



During execution:


state:

EXECUTE


step:

step_1



Verification:


state:

OBSERVE



Result:


PASS



Final:


state:

COMPLETE



---

# 16. Persistence Requirements


Task data must survive:


- process restart
- runtime failure
- machine restart



Initial implementation:


SQLite

or

JSON storage



Future:


distributed persistence



---

# 17. Design Rules


## Rule 1


TaskSession owns lifecycle.



Runtime Session does not.



---

## Rule 2


Plans are structured.



Do not store plans only as text.



---

## Rule 3


Observations are append-only.



History is valuable.



---

## Rule 4


Completion requires evidence.



No evidence.

No completion.



---

# 18. Future Extensions


Possible future fields:


HumanApproval


TaskPriority


CostBudget


ExecutionDeadline


MultiAgentAssignments


DependencyGraph



These should not be added until required.



---

# Summary


TaskSession:

owns the engineering objective.


Plan:

defines intended actions.


Step:

defines executable units.


SuccessCriteria:

defines completion requirements.


Observation:

provides evidence.


RuntimeSession:

provides execution capability.



This separation is the foundation of Forge autonomy.

