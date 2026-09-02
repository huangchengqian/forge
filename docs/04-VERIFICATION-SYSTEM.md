# Forge Verification System Specification


# 1. Purpose


The Verification System determines whether an engineering task has actually achieved its objective.


The purpose is to prevent unreliable completion decisions.



The fundamental principle:


Execution result is not completion.



A runtime may say:


"I changed the code"



But Forge must answer:


"Does this change satisfy the engineering objective?"



---

# 2. Core Philosophy



Traditional Agent:


LLM:

"I think the task is complete"



↓

Complete



Problem:


The model can be incorrect.



---

Forge:


Runtime execution


↓

Verification


↓

Evidence


↓

Completion decision



Only verified results can complete a task.



---

# 3. Verification Responsibility


Verification belongs to Forge.



Verification does not belong to:


- Pi Runtime
- LLM
- UI
- User conversation



---

# 4. Verification Flow



Execution:



Plan Step


↓

EXECUTE


↓

Runtime Result



Verification:



Runtime Result

+

Success Criteria


↓

Validator


↓

Observation


↓

PASS / FAIL



---

# 5. Success Criteria Model


Every executable step should define success criteria.



A success criterion describes:


"What evidence proves this step is complete?"



Example:



Goal:


Add authentication API



Step:


Create authentication controller



Success Criteria:



file_exists:


src/auth/AuthController.java



command_exit_zero:


mvn test



---

# 6. Criteria Types



Initial supported criteria:



## file_exists



Purpose:


Verify a file exists.



Example:



{

type:

"file_exists",


value:

"src/AuthService.java"


}



Validation:



Check filesystem.



Result:



PASS:

file exists



FAIL:

file missing



---

# 7. file_contains



Purpose:


Verify a file contains required content.



Example:



{

type:

"file_contains",


value:

"src/AuthService.java:class AuthService"


}



Validation:



Read file content.

Search expected pattern.



---

# 8. command_exit_zero



Purpose:


Verify a command succeeds.



Example:



{

type:

"command_exit_zero",


value:

"npm test"


}



Validation:



Execute command.



Result:



Exit code:

0

=

PASS



Other:

FAIL



---

# 9. test_pass



Purpose:


Verify automated tests succeed.



Example:



{

type:

"test_pass",


value:

"AuthServiceTest"


}



Validation:



Run specified test.



---

# 10. Future Criteria Types



Possible extensions:



## api_response



Verify API behavior.



Example:



GET /users


Expected:


HTTP 200



---


## database_state



Verify database changes.



Example:



table exists



---


## performance_check



Verify performance requirement.



Example:



response time < 200ms



---

# 11. Validator Design


Validators should be independent functions.



Conceptual interface:



interface Validator {



type:string



validate(

criteria

):VerificationResult



}



---

# 12. Verification Result


Example:



VerificationResult:



{

passed:true,


criterion:

{


type:

"file_exists",


value:

"src/auth.ts"


},


message:

"File exists"

}



---

# 13. Observation Creation



Every verification creates an Observation.



Example:



Observation:



{

stepId:

"step-001",


result:

"PASS",


criteriaResults:

[

...

]


}



---

# 14. Observation Rules



Observations are:


- immutable
- append-only
- traceable



Never:


overwrite previous verification results.



Reason:


The history explains:


- why a task failed
- how recovery happened
- what the agent tried



---

# 15. Completion Rules



A step is complete only when:



ALL success criteria pass.



Example:



Step:



Implement login API



Criteria:



file_exists:

LoginController.java



AND



command_exit_zero:

npm test



Both pass:


Step completed.



---

# 16. Task Completion Rules



A task is complete only when:



ALL steps:


completed



AND



ALL observations:


passed



AND



No pending fixes



---

# 17. Failure Handling



Verification failure creates a recovery path.



Example:



Execution:



Agent creates controller



Observation:



FAIL



Reason:



Test failed



Forge:



FIX


↓

New execution instruction


↓

Retry



---

# 18. Verification Independence


Verification should not depend on:


- LLM reasoning
- prompt output
- chat messages



Verification should be:


- deterministic
- reproducible
- testable



---

# 19. Anti Patterns



## Anti Pattern 1


LLM says:


"The implementation is complete"



Forge:


COMPLETE



Forbidden.



---

## Anti Pattern 2


Use natural language only:



"Code looks good"



Forbidden.



---

## Anti Pattern 3


Hide verification inside prompts.



Example:



"Please make sure everything works."



Forbidden.



---

# 20. Development Priority



Phase 1 validators:



Implement:


file_exists


command_exit_zero



Phase 2:



Add:


file_contains


test_pass



Phase 3:



Add:


domain specific validators



---

# Summary



Verification transforms Forge from:



An agent that performs actions



into:



An engineering system that proves results.



The runtime provides execution.


The verifier provides truth.


Forge completes only when evidence exists.

