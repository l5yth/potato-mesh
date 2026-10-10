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

# Stand-ins for the Python interpreter of the Meshtastic payload decoder,
# shared by the decoder specs (+meshtastic_payload_decoder_spec.rb+,
# +meshtastic/payload_decoder_bounds_spec.rb+ and
# +meshtastic/decoder_process_spec.rb+).  Each one is a +/bin/sh+ script that
# ignores its arguments, the decoder script path, and does what an example
# needs: reply, fail, sleep, or record its pid.
module StubInterpreter
  # The real decoder's reply for a POSITION_APP payload.
  POSITION_REPLY = '{"portnum":3,"type":"POSITION_APP","payload":{"latitude_i":525598720,"longitude_i":136577024,"altitude":11,"time":1760000000}}'

  module_function

  # Write +body+ as an executable shell script.
  #
  # @param dir [String] directory that receives the script.
  # @param body [String] shell commands that follow the +#!/bin/sh+ line.
  # @param name [String] file name of the script.
  # @return [String] absolute path of the script.
  def write(dir, body, name: "python")
    path = File.join(dir, name)
    File.write(path, "#!/bin/sh\n#{body}\n")
    FileUtils.chmod(0o755, path)
    path
  end

  # Write a script that reads its whole request, as the decoder does, then
  # prints +reply+ and exits with +status+.
  #
  # @param dir [String] directory that receives the script.
  # @param reply [String] stdout of the script; must not contain a single quote.
  # @param status [Integer] exit status of the script.
  # @param before [String] shell commands run before the reply.
  # @return [String] absolute path of the script.
  def replying(dir, reply = POSITION_REPLY, status: 0, before: "")
    write(dir, "cat > /dev/null\n#{before}\nprintf '%s' '#{reply}'\nexit #{status}")
  end

  # Read the pid a script wrote to +path+, waiting for the file to appear.
  #
  # @param path [String] file holding the pid.
  # @param timeout [Numeric] seconds to wait for the file.
  # @return [Integer] the pid.
  def read_pid(path, timeout: 2)
    give_up = monotonic_now + timeout
    sleep(0.005) until File.size?(path) || monotonic_now > give_up
    Integer(File.read(path))
  end

  # Report whether +pid+ names a process, a zombie included, as
  # +Process.kill(0, pid)+ sees it.
  #
  # @param pid [Integer] process id.
  # @return [Boolean] false once the process is gone and reaped.
  def exists?(pid)
    Process.kill(0, pid)
    true
  rescue Errno::ESRCH
    false
  end

  # @return [Float] seconds on the monotonic clock.
  def monotonic_now
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
