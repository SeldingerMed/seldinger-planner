def test_build_status_reads_actual_files_without_listing_credentials(tmp_path):
    from planner.probe import read_build_status

    (tmp_path / "planner").mkdir()
    (tmp_path / "planner" / "agent.py").write_text("# implementation")
    (tmp_path / ".env").write_text("MODEL_API_KEY=do-not-disclose")
    status = read_build_status(tmp_path, "challenge")
    assert status["agent_source_present"] is True
    assert status["provider_source_present"] is False
    assert status["verification_nonce"] == "challenge"
    assert "do-not-disclose" not in str(status)
    assert ".env" not in str(status)
