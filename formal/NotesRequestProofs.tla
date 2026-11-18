------------------------- MODULE NotesRequestProofs -------------------------
EXTENDS NotesRequest, TLAPS

THEOREM Initialization == Init => Safety
    BY DEF Init, Safety

THEOREM Preservation == Safety /\ [Next]_vars => Safety'
    <1> USE DEF Safety, vars
    <1>1 ManualRequest /\ Safety => Safety'
        BY DEF ManualRequest, BeginRequest
    <1>2 \A aborted \in BOOLEAN : AgentSettled(aborted) /\ Safety => Safety'
        BY DEF AgentSettled, BeginRequest
    <1>3 (StartSession \/ StopSession \/ Invalidate) /\ Safety => Safety'
        BY DEF StartSession, StopSession, Invalidate
    <1>4 \A isNote \in BOOLEAN : StartTurn(isNote) /\ Safety => Safety'
        BY DEF StartTurn
    <1>5 \A isIdle, hasMessages \in BOOLEAN : SetQueue(isIdle, hasMessages) /\ Safety => Safety'
        BY DEF SetQueue
    <1>6 \A ticket \in reading : (ReadSucceeded(ticket) \/ ReadFailed(ticket)) /\ Safety => Safety'
        BY DEF ReadSucceeded, ReadFailed
    <1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6 DEF Next

THEOREM StepSafety ==
    [Next]_vars => [FreshDispatch /\ FreshError /\ ReadyAtStart /\ NoAutomaticRetry]_vars
    <1>1 Next => FreshDispatch /\ FreshError
        BY DEF Next, FreshDispatch, FreshError, ManualRequest, AgentSettled, StartSession,
               StopSession, StartTurn, Invalidate, SetQueue, ReadSucceeded, ReadFailed
    <1>2 Next => ReadyAtStart
        BY DEF Next, ReadyAtStart, ManualRequest, AgentSettled, BeginRequest, StartSession,
               StopSession, StartTurn, Invalidate, SetQueue, ReadSucceeded, ReadFailed
    <1>3 NoAutomaticRetry BY DEF NoAutomaticRetry, AgentSettled
    <1> QED BY <1>1, <1>2, <1>3

THEOREM Correctness ==
    Spec => []Safety /\ DispatchSafety /\ ErrorSafety /\ PreparationSafety /\ RetrySafety
    <1>1 Spec => []Safety BY PTL, Initialization, Preservation DEF Spec
    <1>2 [FreshDispatch /\ FreshError /\ ReadyAtStart /\ NoAutomaticRetry]_vars =>
            [FreshDispatch]_vars /\ [FreshError]_vars /\ [ReadyAtStart]_vars /\ [NoAutomaticRetry]_vars
        OBVIOUS
    <1> QED BY PTL, <1>1, <1>2, StepSafety
             DEF Spec, DispatchSafety, ErrorSafety, PreparationSafety, RetrySafety

=============================================================================
