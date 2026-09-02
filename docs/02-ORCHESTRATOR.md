# Forge Orchestrator Specification


# 1. Purpose


The Orchestrator is the core intelligence layer of Forge.


The Orchestrator controls the complete lifecycle of an engineering task.


Its responsibility:


- decide what phase the task is in
- decide what action should happen next
- coordinate runtime execution
- evaluate results
- recover from failures
- determine completion



The Orchestrator is the brain of Forge.



---

# 2. Fundamental Principle


Forge and Runtime operate at different levels.



Runtime answers:


"How do I perform this action?"



Forge answers:


"What action should happen next?"



Example:



User:


"Add user authentication"



Forge:


Need to:

1. Understand repository

2. Create implementation plan

3. Execute changes

4. Verify behavior

5. Fix failures



Pi Runtime:


How to inspect files.

How to modify code.

How to run commands.



---

# 3. Double Loop Architecture



Forge contains two loops.



## Outer Loop


Owned by Forge.



Responsible for:


Engineering lifecycle.



Flow:


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



---

## Inner Loop


Owned by Pi Runtime.



Responsible for:


Agent execution.



Flow:


Turn

↓

Reasoning

↓

Tool Call

↓

Tool Result

↓

Turn Result



---

# 4. Loop Boundary


The two loops must remain independent.



Incorrect:


Pi decides:


"I have completed the task"



Then:


Forge marks COMPLETE



This creates unreliable completion.



---

Correct:


Pi returns execution result.



Forge evaluates:


Does this satisfy success criteria?



Only Forge can complete the task.



---

# 5. State Machine


The Orchestrator uses an explicit state machine.



States:


READY


UNDERSTAND


PLAN


EXECUTE


OBSERVE


FIX


COMPLETE


FAILED



---

# 6. READY State



Purpose:


Initialize task execution.



Input:


User goal



Actions:


- create TaskSession
- initialize metadata
- prepare workspace



Output:


TaskSession(state=READY)



Transition:


READY -> UNDERSTAND



---

# 7. UNDERSTAND State



Purpose:


Build repository understanding.



Responsibilities:


- analyze project structure
- identify relevant modules
- understand constraints
- collect context



Possible runtime usage:


Forge may call Pi for repository exploration.



Example instruction:


"Analyze this repository and identify the components related to user authentication."



Output:


Understanding Context



Example:


{

projectType:

"Spring Boot"


relevantFiles:

[

"UserController.java",

"AuthService.java"

]


constraints:

[

"Use existing security framework"

]

}



Transition:


UNDERSTAND -> PLAN



---

# 8. PLAN State



Purpose:


Create structured execution plan.



The plan must contain:


- ordered steps
- step objectives
- success criteria



Example:



Step 1:


Modify database model



Success Criteria:


file_exists:

UserEntity.java



Step 2:


Implement service



Success Criteria:


test_pass:

UserServiceTest



Output:


Plan



Transition:


PLAN -> EXECUTE



---

# 9. EXECUTE State



Purpose:


Execute current plan step.



Execution flow:



Forge


↓

Create runtime instruction


↓

Pi Runtime


↓

Execution Result



Example instruction:



"Implement Step 2 from the current plan.

Modify authentication service.

Follow existing project patterns."



The Orchestrator does not:


- edit files directly
- run shell commands directly



---

# 10. OBSERVE State



Purpose:


Validate execution result.



Observation is deterministic.



Input:


Execution result


+

Success Criteria



Example:


Criteria:


file_exists:

src/AuthService.java



Validator:


Check filesystem



Result:


PASS

or

FAIL



---

# 11. Successful Observation



If all criteria pass:



Current step:


COMPLETED



If all plan steps complete:


Transition:


OBSERVE -> COMPLETE



Otherwise:


Transition:


OBSERVE -> EXECUTE



---

# 12. Failed Observation



If validation fails:



Transition:


OBSERVE -> FIX



The failure becomes evidence.



Example:


Observation:


FAIL



Reason:


Test failed:

NullPointerException



---

# 13. FIX State



Purpose:


Recover from failure.



FIX decides:


- retry current step
- update instruction
- modify plan



Example:


Previous:


"Implement API endpoint"



Failure:


Test failure due to missing validation



FIX creates:


"Add request validation before implementing endpoint"



Then:


FIX -> EXECUTE



---

# 14. Retry Policy



Forge must prevent infinite loops.



Three limits:



## Step Retry Limit



Example:


Maximum:

3 attempts



---


## Task Fix Limit



Example:


Maximum:

10 fixes



---


## Time Limit



Example:


Maximum:

30 minutes



---

# 15. COMPLETE State



Completion is a system decision.



Requirements:



All steps:


- executed

AND

- verified



The following are NOT valid completion signals:



- LLM says finished

- Runtime returns success

- User conversation ends



---

# 16. FAILED State



Task enters FAILED when:


- retry limit exceeded
- deadline exceeded
- unrecoverable error



Failure information must be stored.



Example:



{

failedStep:

"step_auth"



reason:

"Maximum retries exceeded"



}



---

# 17. Orchestrator Events



The Orchestrator emits lifecycle events.



Events:



state_changed


plan_created


step_started


step_completed


step_failed


fix_started


completed


failed



---

# 18. Error Handling


Errors must be classified.



Categories:



Runtime Error:


Pi execution failure



Verification Error:


Criteria not satisfied



Planning Error:


Invalid plan



System Error:


Forge internal failure



Different errors require different recovery strategies.



---

# 19. Orchestrator Design Rules



Rule 1:


Never hide lifecycle inside prompts.



Rule 2:


Never use conversation history as state.



Rule 3:


Never allow Runtime to decide completion.



Rule 4:


Every transition must be observable.



Rule 5:


Every action must have a reason.



---

# 20. Future Evolution



Possible future states:



WAITING_HUMAN_APPROVAL


BACKGROUND_EXECUTION


MULTI_AGENT_COORDINATION


SCHEDULED_TASK



The state machine should be extensible.



---

# Summary


The Orchestrator transforms Pi from:


"An agent that can use tools"



into:


"An engineering system that can autonomously complete objectives"



Pi provides execution capability.


Forge provides autonomous control.

