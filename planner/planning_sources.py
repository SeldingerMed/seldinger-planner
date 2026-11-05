"""Fixed primary-source context for non-prescriptive research discussion.

This is a small, historical-source bundle, not a live or exhaustive guideline review,
patient-specific recommendation, risk calculator, or device instruction for use.
"""

PLANNING_SOURCE_BUNDLE = {
    "bundle_version": "aneurysm-discussion-v1",
    "clinical_recommendation": False,
    "scope": "Selected primary guideline statements for evidence-gap discussion only.",
    "sources": [
        {
            "id": "ESO_UIA_2022",
            "title": "ESO guidelines on management of unruptured intracranial aneurysms (2022)",
            "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC9446328/",
            "doi": "10.1177/23969873221099736",
            "population": "Adults with unruptured intracranial aneurysms",
            "section": "Recommendation table, PICO 1 and PICO 2",
            "statements": [
                "The table does not state an overall preference for endovascular versus microsurgical treatment based on the available data; its PICO 2 evidence quality is very low.",
                "The expert-consensus discussion compares complete occlusion and complication risks in a multidisciplinary setting, with patient-related factors and shared decision-making.",
                "The flow-diverting-stent statement has conditions concerning alternative treatments and the balance of rupture and treatment risks; this prototype does not estimate those risks.",
            ],
        },
        {
            "id": "NICE_NG228_2022",
            "title": "NICE NG228: subarachnoid haemorrhage caused by a ruptured aneurysm (2022)",
            "url": "https://www.nice.org.uk/guidance/ng228/chapter/Recommendations",
            "published": "2022-11-23",
            "population": "People with subarachnoid haemorrhage caused by a ruptured aneurysm",
            "section": "Recommendations 1.2.4 and 1.2.7",
            "statements": [
                "The culprit-aneurysm discussion involves an interventional neuroradiologist and a neurosurgeon, accounting for clinical condition, aneurysm characteristics, and the amount and location of subarachnoid blood.",
                "The guideline describes discussion of proposed and alternative options with the person and, where appropriate, family or carers, followed by a documented final plan.",
            ],
        },
    ],
    "not_covered": [
        "Device-specific instructions, compatibility or sizing",
        "Individual rupture-risk or procedural-risk estimates",
        "Image interpretation, inferred diagnosis or validated morphometry",
        "A comprehensive comparison of intrasaccular devices or assisted-coiling techniques",
        "Guideline updates after these selected publications",
    ],
}
