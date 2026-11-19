------------------------- MODULE NotesSearchProofs --------------------------
EXTENDS NotesSearch, TLAPS

THEOREM ResolvedSound ==
    ASSUME NEW cache, NEW canonical, NEW key,
           Sound(cache, canonical)
    PROVE ResolveVector(cache, canonical, key) = canonical[key]
    BY DEF Sound, ResolveVector

THEOREM FilledSound ==
    ASSUME NEW cache, NEW canonical, NEW keys,
           Sound(cache, canonical)
    PROVE Sound(Fill(cache, canonical, keys), canonical)
    BY ResolvedSound DEF Sound, Fill

THEOREM Initialization == Init => CacheSound
    BY DEF Init, CacheSound, Sound, Empty

THEOREM Preservation == CacheSound /\ [Next]_vars => CacheSound'
    <1>1 CacheSound /\ UNCHANGED vars => CacheSound'
        BY DEF vars, CacheSound, Sound
    <1>2 \A i \in Slots, key \in NoteKeys \cup {Absent} :
            CacheSound /\ Edit(i, key) => CacheSound'
        BY DEF Edit, CacheSound, Sound
    <1>3 ClearCache => CacheSound'
        BY DEF ClearCache, CacheSound, Sound, Empty
    <1>4 \A q \in QueryKeys : CacheSound /\ Search(q) => CacheSound'
        BY FilledSound DEF Search, CacheSound, Sound
    <1> QED BY <1>1, <1>2, <1>3, <1>4 DEF Next

THEOREM Agreement == CacheSound => SameResults
    <1> ASSUME CacheSound, NEW q \in QueryKeys
         PROVE ReusedResult(q) = RecomputedResult(q)
    <2>1 ResolveVector(cachedQueries, QueryEmbedding, q) = QueryEmbedding[q]
        BY ResolvedSound DEF CacheSound
    <2>2 \A i \in Live :
            Fill(cachedNotes, NoteEmbedding, CurrentKeys)[corpus[i]] = NoteEmbedding[corpus[i]]
        BY ResolvedSound DEF CacheSound, CurrentKeys, Fill
    <2>3 Scores(Fill(cachedNotes, NoteEmbedding, CurrentKeys),
                 ResolveVector(cachedQueries, QueryEmbedding, q))
         = Scores(NoteEmbedding, QueryEmbedding[q])
        BY <2>1, <2>2 DEF Scores
    <2> QED BY <2>3 DEF ReusedResult, RecomputedResult
    <1> QED BY DEF SameResults

THEOREM Correctness == Spec => [](CacheSound /\ SameResults)
    <1>1 Spec => []CacheSound BY PTL, Initialization, Preservation DEF Spec
    <1> QED BY PTL, <1>1, Agreement

=============================================================================
