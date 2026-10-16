# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# frozen_string_literal: true

require "fileutils"
require "tmpdir"

# The suite's one temporary directory (SPEC TD1, TD2).
#
# +spec_helper.rb+ makes it under the TMPDIR the run starts with and points
# TMPDIR at its +tmp+ directory, so every temporary file or directory a spec,
# a gem or a child process makes lands inside it.  An +at_exit+ hook removes
# it however the run ends, short of SIGKILL or a second INT (RSpec's force
# quit, +exit!+): passing, failing, +--dry-run+, a spec file that fails to
# load, one INT or TERM.  Either of those runs no hook and leaves this one
# directory behind, with the test database and keyfile under +xdg-data+ and
# +xdg-config+ and whatever its +tmp+ held.  When the hook cannot remove the
# directory it fails the run ({remove!}), and a spec that leaves anything in
# +tmp+ fails the run ({check!}).
module SuiteTmpdir
  # Name prefix of the suite directory.
  PREFIX = "potato-mesh-spec-"

  # Raised by {check!} when a spec left files or directories in the suite's
  # TMPDIR.
  class LeakError < StandardError; end

  module_function

  # Make the suite directory and its +tmp+ directory, point TMPDIR at +tmp+,
  # and register the directory's removal at exit.
  #
  # @param env [#[]=] environment whose +TMPDIR+ is set; +ENV+ in the suite.
  # @param exit_hook [#call] takes the removal as a block; +Kernel#at_exit+
  #   in the suite.
  # @param on_failure [#call] takes the message when the removal leaves the
  #   directory; +Kernel#abort+ in the suite, which fails the run.
  # @return [String] the suite directory.
  def create!(env: ENV, exit_hook: method(:at_exit), on_failure: method(:abort))
    root = Dir.mktmpdir(PREFIX)
    # Owner-only, as Dir.mktmpdir makes +root+: under umask 0 a world-writable
    # +tmp+ would be refused by Dir.tmpdir, which would then pick another.
    FileUtils.mkdir_p(tmp_path(root), mode: 0o700)
    env["TMPDIR"] = tmp_path(root)
    owner = Process.pid
    # A forked child that exits normally runs the hooks it inherited; only
    # the process that made the directory removes it.
    exit_hook.call { remove!(root, on_failure) if Process.pid == owner }
    root
  end

  # Remove the suite directory, and report through +on_failure+ when any of
  # it is left: +FileUtils.rm_rf+ removes what it can and raises nothing.
  #
  # @param root [String] the suite directory.
  # @param on_failure [#call] takes the message when +root+ is left.
  # @return [void]
  def remove!(root, on_failure)
    FileUtils.rm_rf(root)
    return unless File.exist?(root)

    on_failure.call("SuiteTmpdir: could not remove the suite directory #{root}")
  end

  # The suite's TMPDIR inside the suite directory.
  #
  # @param root [String] the suite directory.
  # @return [String] its +tmp+ directory.
  def tmp_path(root)
    File.join(root, "tmp")
  end

  # Raise {LeakError} naming every entry left in +dir+; an empty or missing
  # directory passes.
  #
  # @param dir [String] the suite's TMPDIR.
  # @return [void]
  # @raise [LeakError] when +dir+ holds anything.
  def check!(dir)
    left = Dir.exist?(dir) ? Dir.children(dir).sort : []
    return if left.empty?

    raise LeakError, "specs left these in the suite TMPDIR #{dir}: #{left.join(", ")}"
  end
end
